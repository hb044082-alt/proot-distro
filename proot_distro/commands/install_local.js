/**
 * # Proot-Distro - manage proot containers.
 * # Created by Sylirre <sylirre@termux.dev> for Termux project.
 * # Development assisted by Claude Code (https://claude.ai/code).
 * #
 * # This program is free software: you can redistribute it and/or modify
 * # it under the terms of the GNU General Public License as published by
 * # the Free Software Foundation, either version 3 of the License, or
 * # (at your option) any later version.
 * #
 * # This program is distributed in the hope that it will be useful,
 * # but WITHOUT ANY WARRANTY; without even the implied warranty of
 * # MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * # GNU General Public License for more details.
 * #
 * # You should have received a copy of the GNU General Public License
 * # along with this program. If not, see <http://www.gnu.org/licenses/>.
 * #
 * # Architecture: Local-archive installs. Two formats are auto-detected
 * # by a streaming probe of the first 500 member names:
 * #
 * # - OCI image layout (oci-layout marker present) — layer blobs are
 * # unpacked into LAYER_CACHE_DIR and applied via apply_layer, mirroring
 * # the on-disk shape produced by a Docker pull. Every blob read out of
 * # the archive is hashed against the digest the archive names it by:
 * # the file is a stranger's (`install ./img.tar`, or an http(s):// URL),
 * # and LAYER_CACHE_DIR is shared with every image the user pulls, so an
 * # unchecked blob would sit there under a digest a later pull trusts.
 * # - Plain rootfs tar — extracted directly into the destination, with
 * # a strip-count heuristic that figures out how many leading path
 * # components to drop so well-known rootfs dirs (`etc`, `usr`, …)
 * # land at the rootfs root.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tar = require('tar-stream');
const zlib = require('zlib');
const { atomicReplace } = require('../atomic');
const { requireReadSupport } = require('../compress');
const { logInfo } = require('../message');
const { clearBar, progressActive, fmtSize } = require('../progress');
const {
    ARCH_TO_DOCKER,
    DOCKER_TO_ARCH,
    applyLayer,
    layerCachePath,
    openVerifiedLayer,
    requireDataDigest,
    splitDigest,
    validateDigest
} = require('../helpers/docker');
const { extractTarToRootfs } = require('../helpers/tar_extract');

const _BLOB_CHUNK = 1024 * 1024;
const _MAX_JSON_BYTES = 16 * 1024 * 1024;
const _MAX_OCI_MEMBERS = 16384;
const _OCI_INDEX_NAME = "index.json";
const _OCI_BLOB_RE = /^blobs\/[A-Za-z0-9]+(?:[+_.\-][A-Za-z0-9]+)*\/[A-Fa-f0-9]+$/;

const _ROOTFS_DIRS = new Set([
    "bin", "dev", "etc", "home", "lib", "lib32", "lib64", "libx32", "media", "mnt", "opt", "proc", "root", "run", "sbin", "srv", "sys", "tmp", "usr", "var",
]);

function detectStripCount(memberNames) {
    const sample = memberNames.slice(0, 500);
    let bestStrip = 0;
    let bestScore = -1;

    for (let strip = 0; strip < 5; strip++) {
        let score = 0;
        for (const name of sample) {
            const parts = name.replace(/^\/+|\/+$/g, "").split("/");
            if (parts.length > strip && _ROOTFS_DIRS.has(parts[strip])) {
                score += 1;
            }
        }
        if (score > bestScore) {
            bestScore = score;
            bestStrip = strip;
        }
    }
    return bestStrip;
}

function extractPlainTar(archivePath, strip, rootfsFd) {
    extractTarToRootfs(archivePath, rootfsFd, { strip });
}

function _ociBlobPath(digest) {
    validateDigest(digest);
    const [algo, hexVal] = digest.split(":", 2);
    return `blobs/${algo}/${hexVal}`;
}

function _ociOpenMember(memberMap, path) {
    const member = memberMap.get(path);
    if (!member) {
        throw new Error(`OCI archive is missing required file: ${path}`);
    }
    if (member.type !== 'file') {
        throw new Error(`OCI archive entry is not a regular file: ${path}`);
    }
    return member.buffer;
}

function _ociReadCapped(memberMap, path) {
    const data = _ociOpenMember(memberMap, path);
    if (data.length > _MAX_JSON_BYTES) {
        throw new Error(`OCI archive entry '${path}' is larger than ${_MAX_JSON_BYTES} bytes; refusing to read it.`);
    }
    return data;
}

function _ociJsonObject(data, what) {
    let payload;
    try {
        payload = JSON.parse(data.toString('utf8'));
    } catch (exc) {
        throw new Error(`${what} is not valid JSON. The archive is corrupt or is not an OCI image.`);
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new Error(`${what} is not a JSON object. The archive is corrupt or is not an OCI image.`);
    }
    return payload;
}

function _ociDigest(entry, what) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error(`${what} is malformed: expected an object describing a blob.`);
    }
    const digest = entry.digest;
    if (typeof digest !== 'string' || !digest) {
        throw new Error(`${what} names no digest.`);
    }
    return digest;
}

function _ociReadJson(memberMap, path) {
    return _ociJsonObject(
        _ociReadCapped(memberMap, path),
        `OCI archive entry '${path}'`
    );
}

function _ociReadBlobJson(memberMap, digest) {
    const path = _ociBlobPath(digest);
    const data = _ociReadCapped(memberMap, path);
    requireDataDigest(data, digest, `OCI archive blob '${path}'`);
    return _ociJsonObject(data, `OCI archive blob '${path}'`);
}

function _ociFindManifestEntry(memberMap, indexManifests, distAuth) {
    if (indexManifests.length === 1) {
        return indexManifests[0];
    }
    const dockerArch = ARCH_TO_DOCKER.get(distAuth, [distAuth, ""])[0];
    const platformEntries = indexManifests.filter(e => typeof e.platform === 'object' && e.platform !== null);
    
    if (platformEntries.length > 0) {
        for (const entry of platformEntries) {
            const p = entry.platform;
            if (p.architecture === dockerArch && p.os === "linux") {
                return entry;
            }
        }
        throw new Error(`No manifest found for architecture '${distAuth}' in OCI index (tried ${dockerArch}).`);
    }

    for (const entry of indexManifests) {
        const manifest = _ociReadBlobJson(memberMap, _ociDigest(entry, "OCI index manifest entry"));
        const config = manifest.config || {};
        const configDigest = (typeof config === 'object' && config !== null) ? config.digest : "";
        if (typeof configDigest !== 'string' || !configDigest) continue;
        const imageConfig = _ociReadBlobJson(memberMap, configDigest);
        if (imageConfig.architecture === dockerArch) {
            return entry;
        }
    }
    throw new Error(`No manifest found for architecture '${distAuth}' in OCI image (tried ${dockerArch}).`);
}

function _ociCacheLayer(memberMap, digest) {
    const blobPath = _ociBlobPath(digest);
    const [_, expectedHex] = splitDigest(digest);
    const data = _ociOpenMember(memberMap, blobPath);
    const cachePath = layerCachePath(digest);

    const hasher = crypto.createHash('sha256');
    hasher.update(data);
    const actualHex = hasher.digest('hex');

    if (actualHex !== expectedHex) {
        throw new Error(`OCI archive layer blob '${blobPath}' does not match its digest (expected ${digest}, got sha256:${actualHex}). The archive is corrupt or was tampered with.`);
    }

    const tmpFd = atomicReplace(cachePath, (tmpPath) => {
        fs.writeFileSync(tmpPath, data);
    });

    const fd = fs.openSync(cachePath, 'r');
    return fd;
}

function _extractOci(memberMap, rootfsFd, distAuth) {
    const index = _ociReadJson(memberMap, "index.json");
    let indexManifests = index.manifests;
    if (!Array.isArray(indexManifests)) {
        throw new Error("OCI index.json is malformed: 'manifests' is not a list.");
    }
    indexManifests = indexManifests.filter(e => typeof e === 'object' && e !== null);
    if (indexManifests.length === 0) {
        throw new Error("OCI index.json contains no manifests.");
    }

    const manifestEntry = _ociFindManifestEntry(memberMap, indexManifests, distAuth);
    const manifest = _ociReadBlobJson(memberMap, _ociDigest(manifestEntry, "OCI index manifest entry"));
    const config = manifest.config || {};
    if (typeof config !== 'object' || config === null) {
        throw new Error("OCI image manifest has a malformed config.");
    }
    const configDigest = config.digest || "";
    if (typeof configDigest !== 'string' || !configDigest) {
        throw new Error("OCI image manifest has no config digest.");
    }

    const imageConfig = _ociReadBlobJson(memberMap, configDigest);
    const dockerArch = imageConfig.architecture || "";
    const actualArch = DOCKER_TO_ARCH.get(typeof dockerArch === 'string' ? dockerArch : "", distAuth);

    const layers = manifest.layers;
    if (!Array.isArray(layers)) {
        throw new Error("OCI image manifest is malformed: 'layers' is not a list.");
    }
    if (layers.length === 0) {
        throw new Error("OCI image manifest contains no layers.");
    }

    for (const layer of layers) {
        _ociDigest(layer, "OCI image layer");
    }

    const nLayers = layers.length;
    for (let i = 0; i < nLayers; i++) {
        const layer = layers[i];
        const digest = layer.digest;
        const shortId = digest.substring(0, 19);
        const size = layer.size || 0;
        const sizeStr = (typeof size === 'number' && size > 0) ? ` (${fmtSize(size)})` : "";

        let layerFd = openVerifiedLayer(digest);
        if (layerFd !== null) {
            logInfo(`${shortId}: Layer ${i + 1}/${nLayers} already cached, skipping.`);
        } else {
            logInfo(`${shortId}: Caching layer ${i + 1}/${nLayers}${sizeStr}...`);
            layerFd = _ociCacheLayer(memberMap, digest);
            logInfo(`${shortId}: Applying layer ${i + 1}/${nLayers}...`);
            try {
                applyLayer(layerFd, rootfsFd, { digest });
            } finally {
                try {
                    fs.closeSync(layerFd);
                } catch (e) {}
            }
        }
    }

    const annotations = manifestEntry.annotations || {};
    const safeAnnotations = (typeof annotations === 'object' && annotations !== null) ? annotations : {};
    const imageRef = safeAnnotations["io.containerd.image.name"] || safeAnnotations["org.opencontainers.image.ref.name"] || "";

    return {
        manifest,
        imageConfig,
        imageRef: typeof imageRef === 'string' ? imageRef : "",
        arch: actualArch,
    };
}

async function _indexOciMembers(archivePath) {
    return new Promise((resolve, reject) => {
        const memberMap = new Map();
        let scanned = 0;
        const extractStream = tar.extract();

        extractStream.on('entry', (header, stream, next) => {
            scanned++;
            if (scanned > _MAX_OCI_MEMBERS) {
                stream.destroy();
                return reject(new Error(`OCI archive declares more than ${_MAX_OCI_MEMBERS} entries; refusing to index it.`));
            }

            const name = header.name;
            const isTarget = (name === _OCI_INDEX_NAME || _OCI_BLOB_RE.test(name));

            let chunks = [];
            stream.on('data', (chunk) => {
                if (isTarget) chunks.push(chunk);
            });

            stream.on('end', () => {
                if (isTarget) {
                    memberMap.set(name, {
                        type: header.type,
                        buffer: Buffer.concat(chunks)
                    });
                }
                next();
            });

            stream.on('error', (err) => {
                next(err);
            });
        });

        extractStream.on('finish', () => {
            resolve(memberMap);
        });

        extractStream.on('error', (err) => {
            reject(err);
        });

        const fileStream = fs.createReadStream(archivePath);
        fileStream.pipe(extractStream);
    });
}

async function installFromLocalFile(archivePath, rootfsFd, distAuth) {
    requireReadSupport(archivePath, `archive '${archivePath}'`);

    const probeNames = [];
    let isOci = false;

    await new Promise((resolve, reject) => {
        const extractStream = tar.extract();
        extractStream.on('entry', (header, stream, next) => {
            probeNames.push(header.name);
            if (header.name === "oci-layout") {
                isOci = true;
                stream.destroy();
                return resolve();
            }
            if (probeNames.length >= 500) {
                stream.destroy();
                return resolve();
            }
            stream.on('end', () => next());
            stream.resume();
        });

        extractStream.on('finish', () => resolve());
        extractStream.on('error', (err) => resolve()); // Ignore stream errors during probing

        fs.createReadStream(archivePath).pipe(extractStream);
    });

    if (isOci) {
        if (progressActive()) {
            logInfo("Indexing OCI archive...");
        }
        let memberMap;
        try {
            memberMap = await _indexOciMembers(archivePath);
        } finally {
            clearBar();
        }
        return _extractOci(memberMap, rootfsFd, distAuth);
    }

    const strip = detectStripCount(probeNames);
    extractPlainTar(archivePath, strip, rootfsFd);
    return null;
}

module.exports = {
    detectStripCount,
    extractPlainTar,
    installFromLocalFile,
};
