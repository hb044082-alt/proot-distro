/**
 * Proot-Distro - manage proot containers.
 * Created by Sylirre <sylirre@termux.dev> for Termux project.
 * Development assisted by Claude Code (https://claude.ai/code).
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { statedir, dirfd } = require('../statedir');
const { atomicWrite } = require('../atomic');
const { BASE_CACHE_DIR, PROGRAM_NAME } = require('../constants');
const { C, msg, logInfo, logError, critError } = require('../message');
const { clearBar } = require('../progress');
const { ContainerLock } = require('../locking');
const { getDeviceCpuArch, normalizeArch } = require('../arch');
const { isValidName, requireValidName } = require('../names');
const {
    containerDir,
    containerManifest,
    containerRootfs,
    containerIsInstalled,
    openContainerPair
} = require('../paths');
const { setupFakeSysdata } = require('../sysdata');
const { deriveAlias, pullImage } = require('../helpers/docker');
const {
    openEtc,
    registerAndroidIdsAt,
    writeHostsAt,
    writeResolvConfAt
} = require('../helpers/rootfs');
const { downloadFile } = require('../helpers/download');
const { installFromLocalFile } = require('./install_local');

// Archive extensions stripped when deriving a container name from a filename.
const _ARCHIVE_EXTS = [
    ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz",
    ".oci.tar.xz", ".oci.tar.gz", ".oci.tar.zst", ".oci.tar",
    ".tar.lzma", ".tlzma", ".tar.zst", ".tzst", ".tar"
];

function _isLocalPath(ref) {
    return ref.startsWith("/") || ref.startsWith("./") || ref.startsWith("../") || ref.startsWith("~");
}

function _isUrl(ref) {
    return ref.startsWith("http://") || ref.startsWith("https://");
}

function _deriveLocalName(filePath) {
    const baseName = path.basename(filePath);
    let low = baseName.toLowerCase();
    let base = baseName;
    for (const ext of _ARCHIVE_EXTS) {
        if (low.endsWith(ext)) {
            base = base.slice(0, -ext.length);
            break;
        }
    }
    base = base.toLowerCase().replace(/[^a-z0-9_.\-]/g, "-");
    base = base.replace(/^[^a-z0-9]+/, "");
    base = base.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
    return base;
}

function _cacheTempFile(prefix) {
    const dirFd = statedir.openStateDir(BASE_CACHE_DIR, { create: true });
    try {
        const randHex = crypto.randomBytes(4).toString('hex');
        const name = dirfd.tempName(prefix, `.${process.pid}.${randHex}.tmp`);
        const [fd] = dirfd.openNewAt(dirFd, name, 0o600);
        fs.closeSync(fd);
        return path.join(BASE_CACHE_DIR, name);
    } finally {
        fs.closeSync(dirFd);
    }
}

function commandInstall(args) {
    const imageRef = args.imageRef;
    const customContainerName = args.customContainerName || null;

    if (customContainerName !== null && !customContainerName) {
        critError("container name can't be empty.");
        process.exit(1);
    }

    if (customContainerName) {
        requireValidName(customContainerName);
    }

    const deviceArch = getDeviceCpuArch();
    const rawArch = args.overrideArch || null;
    let distArch;

    if (rawArch) {
        distArch = normalizeArch(rawArch);
        if (!distArch) {
            critError(
                `unknown architecture '${rawArch}'. Valid values: aarch64, arm, i686, riscv64, x86_64 ` +
                `(or Docker format: linux/arm64, linux/amd64, linux/arm/v7, linux/386, linux/riscv64).`
            );
            process.exit(1);
        }
    } else {
        distArch = deviceArch;
    }

    let localPath = _isLocalPath(imageRef) ? imageRef.replace(/^~/, os.homedir()) : null;
    let url = _isUrl(imageRef) ? imageRef : null;

    const installName = _resolveInstallName(imageRef, localPath, url, customContainerName);
    const allowInsecure = Boolean(args.allowInsecure);

    const lock = new ContainerLock(installName, { exclusive: true, command: "install" });
    lock.withLock(() => {
        _runInstall(installName, imageRef, localPath, url, distArch, allowInsecure);
    });
}

function _resolveInstallName(imageRef, localPath, url, customContainerName) {
    if (localPath !== null) {
        if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) {
            critError(`local file '${localPath}' does not exist or is not a regular file.`);
            process.exit(1);
        }
        if (customContainerName) return customContainerName;
        const derived = _deriveLocalName(localPath);
        if (!derived || !isValidName(derived)) {
            critError(`cannot determine a valid container name from '${path.basename(localPath)}'. Specify the name with '--name NAME'.`);
            process.exit(1);
        }
        return derived;
    }

    if (url !== null) {
        if (customContainerName) return customContainerName;
        const urlPath = url.split("?")[0].split("#")[0];
        const derived = _deriveLocalName(urlPath);
        if (!derived || !isValidName(derived)) {
            critError(`cannot determine a valid container name from '${url}'. Specify the name with '--name NAME'.`);
            process.exit(1);
        }
        return derived;
    }

    const derived = customContainerName ? customContainerName : deriveAlias(imageRef);
    if (!isValidName(derived)) {
        critError(`cannot derive a valid container name from '${imageRef}'. Specify the name with '--name NAME'.`);
        process.exit(1);
    }
    return derived;
}

function _isRegularAt(dirFd, name) {
    try {
        const st = dirfd.lstatAt(dirFd, name);
        return st.isFile();
    } catch {
        return false;
    }
}

function _runInstall(installName, imageRef, localPath, url, distArch, allowInsecure = false) {
    const containerPath = containerDir(installName);
    const rootfsDir = containerRootfs(installName);

    if (containerIsInstalled(installName)) {
        msg();
        critError(`container '${installName}' already exists. Specify a different name with '--name NAME'.`);
        msg();
        msg(`${C.CYAN}Start shell: ${C.GREEN}${PROGRAM_NAME} login ${installName}${C.RST}`);
        msg(`${C.CYAN}Reinstall: ${C.GREEN}${PROGRAM_NAME} reset ${installName}${C.RST}`);
        msg(`${C.CYAN}Uninstall: ${C.GREEN}${PROGRAM_NAME} remove ${installName}${C.RST}`);
        msg();
        process.exit(1);
    }

    if (localPath !== null) {
        logInfo(`Installing from '${path.basename(localPath)}' as '${installName}'...`);
    } else if (url !== null) {
        logInfo(`Installing from URL '${url}' as '${installName}'...`);
    } else {
        const lastComponent = imageRef.split("/").pop();
        const displayRef = lastComponent.includes(":") ? imageRef : `${imageRef}:latest`;
        logInfo(`Installing '${displayRef}' as '${installName}'...`);
    }

    const [containerFd, rootfsFd] = openContainerPair(installName, { create: true });

    const _cleanup = () => {
        statedir.removeStateTree(containerPath);
    };

    let tmpArchive = null;
    let metadata = null;
    try {
        if (localPath !== null) {
            logInfo("Extracting rootfs from archive...");
            metadata = installFromLocalFile(localPath, rootfsFd, distArch);
        } else if (url !== null) {
            tmpArchive = _cacheTempFile(`dl_install_${installName}`);
            logInfo("Downloading archive...");
            downloadFile(url, tmpArchive, { insecure: allowInsecure });
            logInfo("Extracting rootfs from archive...");
            metadata = installFromLocalFile(tmpArchive, rootfsFd, distArch);
        } else {
            metadata = pullImage(imageRef, rootfsFd, distArch, { insecure: allowInsecure });
        }

        if (metadata !== null) {
            const manifestData = {
                image_ref: metadata.image_ref || (localPath === null ? imageRef : ""),
                arch: metadata.arch || distArch,
                manifest: metadata.manifest || {},
                image_config: metadata.image_config || {}
            };
            try {
                const manifestPath = containerManifest(installName);
                atomicWrite(manifestPath, JSON.stringify(manifestData, null, 2), "w");
            } catch (exc) {
                logError(`Warning: could not write manifest.json: ${exc.message}`);
            }
        }

        const etcFd = openEtc(rootfsFd);
        if (etcFd !== null) {
            try {
                logInfo("Updating '/etc/resolv.conf'...");
                writeResolvConfAt(etcFd);
                logInfo("Updating '/etc/hosts'...");
                writeHostsAt(etcFd);
                if (_isRegularAt(etcFd, "passwd")) {
                    logInfo("Registering Android-specific UIDs and GIDs...");
                    registerAndroidIdsAt(etcFd);
                }
            } finally {
                fs.closeSync(etcFd);
            }
        }

        setupFakeSysdata(rootfsDir, { containerFd });
    } catch (exc) {
        if (exc.name === 'KeyboardInterrupt') {
            clearBar();
            logError("Aborted by user.");
            _cleanup();
            process.exit(1);
        } else {
            clearBar();
            logError(`Failed to install: ${exc.message}`);
            logError("See 'proot-distro install --help' on how to install distribution image.");
            _cleanup();
            process.exit(1);
        }
    } finally {
        fs.closeSync(rootfsFd);
        fs.closeSync(containerFd);
        if (tmpArchive !== null) {
            try {
                fs.unlinkSync(tmpArchive);
            } catch {}
        }
    }

    logInfo("Finished installation.");
    msg();

    const entrypoint = metadata?.image_config?.config?.Entrypoint;
    const shellLabel = entrypoint ? "Start shell: " : "Start shell:";
    msg(`${C.CYAN}${shellLabel} ${C.GREEN}${PROGRAM_NAME} login ${installName}${C.RST}`);
    if (entrypoint) {
        msg(`${C.CYAN}Run entrypoint: ${C.GREEN}${PROGRAM_NAME} run ${installName}${C.RST}`);
    }
    msg();
}

module.exports = {
    commandInstall,
    _isLocalPath,
    _isUrl,
    _deriveLocalName,
    _cacheTempFile,
    _resolveInstallName,
    _runInstall
};
