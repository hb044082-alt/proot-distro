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
 * # Architecture: CLI entry point with JSON output support (--json flag)
 * # and version option support (--version / -v).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const process = require('process');
const { execSync, spawnSync } = require('child_process');

const VERSION = "1.0.1";
const { IS_TERMUX, PROGRAM_NAME, PROGRAM_VERSION, CANONICAL_PROGRAM_NAME } = require('./constants');
const { C, msg, set_quiet, crit_error } = require('./message');
const { get_proot_bin } = require('./arch');
const { ALIAS_TO_CANONICAL, build_parser, required_args_for } = require('./parser');

const { command_help, HELP_COMMANDS } = require('./commands/help');
const { command_install } = require('./commands/install');
const { command_remove } = require('./commands/remove');
const { command_rename } = require('./commands/rename');
const { command_reset } = require('./commands/reset');
const { command_login } = require('./commands/login');
const { command_list } = require('./commands/list');
const { command_backup } = require('./commands/backup');
const { command_restore } = require('./commands/restore');
const { command_clear_cache } = require('./commands/clear_cache');
const { command_copy } = require('./commands/copy');
const { command_sync } = require('./commands/sync');
const { command_run } = require('./commands/run');
const { command_build } = require('./commands/build');
const { command_push } = require('./commands/push');
const { command_ps } = require('./commands/ps');
const { command_kill } = require('./commands/kill');
const { command_search } = require('./commands/search');

const _COMMAND_HANDLERS = {
    "install": command_install,
    "remove": command_remove,
    "rename": command_rename,
    "reset": command_reset,
    "login": command_login,
    "list": command_list,
    "backup": command_backup,
    "restore": command_restore,
    "clear-cache": command_clear_cache,
    "copy": command_copy,
    "sync": command_sync,
    "run": command_run,
    "build": command_build,
    "push": command_push,
    "ps": command_ps,
    "kill": command_kill,
    "search": command_search,
    "help": command_help,
};

let _jsonOutputEnabled = false;

function output_json(success, dataOrMessage, extra = {}) {
    if (!_jsonOutputEnabled) return;
    const payload = {
        success,
        [success ? "data" : "error"]: dataOrMessage,
        ...extra
    };
    console.log(JSON.stringify(payload, null, 2));
}

function _sigquit_to_keyboard_interrupt() {
    process.emit('SIGINT');
}

function _refuse_nested_proot() {
    const err_message = (
        `attempted to run ${PROGRAM_NAME} in a proot session. ` +
        "Please check your system configuration to ensure that this program " +
        "does not run under any other proot instance. Additionally check the " +
        `target container to ensure it does not invoke ${PROGRAM_NAME} on ` +
        "a loop basis. With 100% confidence this is not a mistake. Do not " +
        "send bug reports!"
    );

    try {
        const pid = process.pid;
        const statusPath = `/proc/${pid}/status`;
        if (!fs.existsSync(statusPath)) return;
        
        const content = fs.readFileSync(statusPath, 'utf8');
        let tracerPid = 0;
        for (const line of content.split('\n')) {
            if (line.startsWith("TracerPid:")) {
                const parts = line.split(/\s+/);
                if (parts.length >= 2) {
                    tracerPid = parseInt(parts[1], 10);
                }
                break;
            }
        }

        if (tracerPid === 0) return;

        const tracerStatusPath = `/proc/${tracerPid}/status`;
        if (fs.existsSync(tracerStatusPath)) {
            const tContent = fs.readFileSync(tracerStatusPath, 'utf8');
            for (const tline of tContent.split('\n')) {
                if (tline.startsWith("Name:") && tline.includes("proot")) {
                    if (_jsonOutputEnabled) {
                        output_json(false, err_message);
                    } else {
                        crit_error(err_message);
                    }
                    process.exit(1);
                }
            }
        }
    } catch (e) {
        // Ignore if /proc is not available or readable
    }
}

function ensure_proot_installed() {
    if (process.env.PD_PROOT_BIN) {
        try {
            get_proot_bin();
        } catch (e) {
            if (_jsonOutputEnabled) {
                output_json(false, e.message);
            }
            process.exit(1);
        }
    }

    let hasProot = false;
    try {
        const cmd = process.platform === 'win32' ? 'where proot' : 'which proot';
        execSync(cmd, { stdio: 'ignore' });
        hasProot = true;
    } catch (e) {
        hasProot = false;
    }

    if (hasProot) return;

    if (_jsonOutputEnabled) {
        output_json(false, "proot utility does not exist on your system.");
        process.exit(1);
    }

    msg();
    crit_error("proot utility does not exist on your system.");
    msg();

    if (!IS_TERMUX) {
        process.exit(1);
    }

    const isTty = process.stdin.isTTY;
    if (!isTty) {
        msg(`${C.CYAN}Install it with: ${C.GREEN}pkg install proot${C.RST}`);
        msg();
        process.exit(1);
    }

    process.stderr.write(`${C.CYAN}Would you like to install it now? [y/N] ${C.RST}`);
    
    try {
        const buffer = Buffer.alloc(1024);
        const bytesRead = fs.readSync(0, buffer, 0, 1024, null);
        const answer = buffer.toString('utf8', 0, bytesRead).trim().toLowerCase();
        if (answer !== 'y' && answer !== 'yes') {
            msg();
            msg(`${C.CYAN}Install it manually with: ${C.GREEN}pkg install proot${C.RST}`);
            msg();
            process.exit(1);
        }
    } catch (err) {
        msg();
        msg(`${C.CYAN}Install it manually with: ${C.GREEN}pkg install proot${C.RST}`);
        msg();
        process.exit(1);
    }

    msg();
    try {
        spawnSync("pkg", ["install", "-y", "-q", "proot"], { stdio: 'inherit', shell: true });
    } catch (exc) {
        msg();
        crit_error(`failed to install proot: ${exc.message}`);
        msg();
        process.exit(1);
    }
}

function _ensure_proot_available(firstCanonical) {
    if (["build", "push", "kill", "ps", "search"].includes(firstCanonical)) {
        return;
    }
    ensure_proot_installed();
}

function _dispatch_help(rawArgs) {
    if (rawArgs.length < 2 || !["-h", "--help", "--usage"].includes(rawArgs[1])) {
        return false;
    }
    const cmd = ALIAS_TO_CANONICAL.get(rawArgs[0]) || rawArgs[0];
    if (HELP_COMMANDS[cmd]) {
        if (_jsonOutputEnabled) {
            output_json(true, `Help requested for ${cmd}`);
        } else {
            HELP_COMMANDS[cmd]();
        }
        return true;
    }
    return false;
}

function _reject_unknown_command(rawArgs) {
    if (rawArgs.length === 0) return;
    const first = rawArgs[0];
    if (
        !first.startsWith("-") &&
        !_COMMAND_HANDLERS[first] &&
        !ALIAS_TO_CANONICAL.has(first)
    ) {
        const errMsg = `unknown command '${first}'.`;
        if (_jsonOutputEnabled) {
            output_json(false, errMsg);
        } else {
            msg();
            crit_error(errMsg);
            command_help();
            msg();
        }
        process.exit(1);
    }
}

function _split_separator(canonical, rawArgs, args) {
    if (canonical === "login") {
        if (rawArgs.includes("--")) {
            const sepIdx = rawArgs.indexOf("--");
            args.login_cmd = rawArgs.slice(sepIdx + 1);
        } else {
            args.login_cmd = [];
        }
    } else if (canonical === "run") {
        if (rawArgs.includes("--")) {
            const sepIdx = rawArgs.indexOf("--");
            args.run_args = rawArgs.slice(sepIdx + 1);
        } else {
            args.run_args = [];
        }
    }
}

function main() {
    process.on('SIGQUIT', _sigquit_to_keyboard_interrupt);

    const argv = process.argv.slice(2);

    if (argv.includes("--json")) {
        _jsonOutputEnabled = true;
        const jsonIdx = argv.indexOf("--json");
        argv.splice(jsonIdx, 1);
    }

    if (argv.length >= 1 && (argv[0] === "--version" || argv[0] === "-v")) {
        if (_jsonOutputEnabled) {
            output_json(true, { program: CANONICAL_PROGRAM_NAME, version: VERSION });
        } else {
            console.log(`${CANONICAL_PROGRAM_NAME} v${VERSION}`);
        }
        process.exit(0);
    }

    _refuse_nested_proot();

    let firstCanonical = "";
    if (argv.length >= 1) {
        firstCanonical = ALIAS_TO_CANONICAL.get(argv[0]) || argv[0];
    }

    _ensure_proot_available(firstCanonical);

    if (
        argv.length === 0 ||
        ["-h", "--help", "help", "hel", "he", "h"].includes(argv[0])
    ) {
        if (_jsonOutputEnabled) {
            output_json(true, "Help information retrieved.");
        } else {
            command_help();
        }
        process.exit(0);
    }

    const rawArgs = argv;
    if (_dispatch_help(rawArgs)) {
        process.exit(0);
    }

    _reject_unknown_command(rawArgs);

    const parser = build_parser();
    let args;
    let unknown;
    try {
        const parsed = parser.parse(rawArgs);
        args = parsed.args;
        unknown = parsed.unknown;
    } catch (err) {
        if (rawArgs.includes("--version") || rawArgs.includes("-v") || (args && args.version)) {
            if (_jsonOutputEnabled) {
                output_json(true, { program: CANONICAL_PROGRAM_NAME, version: VERSION });
            } else {
                console.log(`${CANONICAL_PROGRAM_NAME} v${VERSION}`);
            }
            process.exit(0);
        }

        if (_jsonOutputEnabled) {
            output_json(false, err.message);
        } else {
            msg();
            crit_error(err.message);
            command_help();
            msg();
        }
        process.exit(1);
    }

    if (args.version || rawArgs.includes("--version") || rawArgs.includes("-v")) {
        if (_jsonOutputEnabled) {
            output_json(true, { program: CANONICAL_PROGRAM_NAME, version: VERSION });
        } else {
            console.log(`${CANONICAL_PROGRAM_NAME} v${VERSION}`);
        }
        process.exit(0);
    }

    const command = args.command;
    if (!command) {
        const errMsg = `unknown command '${rawArgs[0]}'.`;
        if (_jsonOutputEnabled) {
            output_json(false, errMsg);
        } else {
            msg();
            crit_error(errMsg);
            command_help();
            msg();
        }
        process.exit(1);
    }

    const canonical = ALIAS_TO_CANONICAL.get(command) || command;

    if (args.help) {
        if (_jsonOutputEnabled) {
            output_json(true, `Help for ${canonical}`);
        } else {
            if (HELP_COMMANDS[canonical]) {
                HELP_COMMANDS[canonical]();
            } else {
                command_help();
            }
        }
        process.exit(0);
    }

    let checkUnknown = unknown;
    if (["login", "run"].includes(canonical) && rawArgs.includes("--")) {
        const sepIdx = rawArgs.indexOf("--");
        try {
            const parsedBefore = parser.parse(rawArgs.slice(0, sepIdx));
            checkUnknown = parsedBefore.unknown;
        } catch (e) {}
    }

    if (checkUnknown && checkUnknown.length > 0) {
        const filteredUnknown = checkUnknown.filter(arg => arg !== '--version' && arg !== '-v');
        if (filteredUnknown.length > 0) {
            const bad = filteredUnknown[0];
            const kind = bad.startsWith("-") ? "unrecognized option" : "unexpected argument";
            const errMsg = `${kind}: '${bad}'.`;
            if (_jsonOutputEnabled) {
                output_json(false, errMsg);
            } else {
                msg();
                crit_error(errMsg);
                if (HELP_COMMANDS[canonical]) {
                    HELP_COMMANDS[canonical]();
                }
                msg();
            }
            process.exit(1);
        } else {
            if (_jsonOutputEnabled) {
                output_json(true, { program: CANONICAL_PROGRAM_NAME, version: VERSION });
            } else {
                console.log(`${CANONICAL_PROGRAM_NAME} v${VERSION}`);
            }
            process.exit(0);
        }
    }

    for (const [argName, errorMsg] of required_args_for(canonical, args)) {
        if (args[argName] === undefined || args[argName] === null) {
            if (_jsonOutputEnabled) {
                output_json(false, errorMsg);
            } else {
                msg();
                crit_error(errorMsg);
                if (HELP_COMMANDS[canonical]) {
                    HELP_COMMANDS[canonical]();
                }
            }
            process.exit(1);
        }
    }

    _split_separator(canonical, rawArgs, args);

    if (!["list", "ps"].includes(canonical) && (args.quiet || _jsonOutputEnabled)) {
        set_quiet(true);
    }

    const handler = _COMMAND_HANDLERS[canonical];
    if (!handler) {
        const errMsg = `unknown command '${command}'.`;
        if (_jsonOutputEnabled) {
            output_json(false, errMsg);
        } else {
            crit_error(errMsg);
        }
        process.exit(1);
    }

    try {
        const result = handler(args);
        if (_jsonOutputEnabled && result !== undefined) {
            output_json(true, result);
        }
    } catch (err) {
        if (_jsonOutputEnabled) {
            output_json(false, err.message);
        } else {
            crit_error(err.message);
        }
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    main,
    output_json,
    VERSION,
};
