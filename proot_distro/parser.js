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
 * # Architecture: All argument parsing plumbing for the CLI. Each subcommand is
 * # added by a focused builder; the top-level build_parser() composes them.
 */

const { IS_TERMUX, PROGRAM_NAME } = require('./constants');
const { msg, crit_error } = require('./message');
const { HELP_COMMANDS } = require('./commands/help');

const VERSION = "1.0.1";

class PdArgumentParser {
    constructor(options = {}) {
        this.prog = options.prog || PROGRAM_NAME;
        this.description = options.description || "";
        this._pd_command = null;
        this.arguments = [];
        this.subparsers = null;
        this.subparsersMap = new Map();
    }

    error(message) {
        msg();
        crit_error(message);
        if (this._pd_command && HELP_COMMANDS[this._pd_command]) {
            HELP_COMMANDS[this._pd_command]();
        }
        msg();
        process.exit(1);
    }

    add_argument(...args) {
        let nameOrFlags = [];
        let options = {};

        for (const arg of args) {
            if (typeof arg === 'string') {
                nameOrFlags.push(arg);
            } else if (typeof arg === 'object' && arg !== null) {
                options = arg;
            }
        }

        const argDef = {
            names: nameOrFlags,
            ...options
        };
        this.arguments.push(argDef);
    }

    add_mutually_exclusive_group() {
        const group = {
            arguments: [],
            add_argument: (...args) => {
                this.add_argument(...args);
                group.arguments.push(args[0]);
            }
        };
        return group;
    }

    add_subparsers(options = {}) {
        const dest = options.dest || 'command';
        this.subparsers = {
            dest,
            add_parser: (name, subOptions = {}) => {
                const subParser = new PdArgumentParser({
                    prog: `${this.prog} ${name}`,
                    ...subOptions
                });
                subParser._parent = this;
                this.subparsersMap.set(name, subParser);
                return subParser;
            }
        };
        return this.subparsers;
    }

    parse(argv) {
        let args = { [this.subparsers ? this.subparsers.dest : 'command']: null };
        let unknown = [];
        let i = 0;

        if (argv.includes('--version') || argv.includes('-v')) {
            args.version = true;
            return { args, unknown };
        }

        let subCommandName = null;
        let subCommandArgs = [];

        for (; i < argv.length; i++) {
            const token = argv[i];
            if (token === '-h' || token === '--help') {
                args.help = true;
                return { args, unknown };
            } else if (token === '--version' || token === '-v') {
                args.version = true;
                return { args, unknown };
            } else if (!token.startsWith('-') && this.subparsersMap.has(token)) {
                subCommandName = token;
                subCommandArgs = argv.slice(i + 1);
                break;
            } else if (!token.startsWith('-') && ALIAS_TO_CANONICAL[token] && this.subparsersMap.has(ALIAS_TO_CANONICAL[token])) {
                subCommandName = ALIAS_TO_CANONICAL[token];
                subCommandArgs = argv.slice(i + 1);
                break;
            } else if (token.startsWith('-')) {
                let matched = false;
                for (const argDef of this.arguments) {
                    if (argDef.names.includes(token)) {
                        matched = true;
                        if (argDef.action === 'store_true') {
                            const destName = argDef.dest || token.replace(/^--/, '').replace(/-/g, '_');
                            args[destName] = true;
                        }
                        break;
                    }
                }
                if (!matched) {
                    unknown.push(token);
                }
            } else {
                unknown.push(token);
            }
        }

        if (subCommandName) {
            args[this.subparsers.dest] = subCommandName;
            const subParser = this.subparsersMap.get(subCommandName);
            const subResult = subParser.parseSub(subCommandArgs);
            args = { ...args, ...subResult.args };
            unknown = unknown.concat(subResult.unknown);
        }

        return { args, unknown };
    }

    parseSub(argv) {
        let args = {};
        let unknown = [];
        let positionals = [];

        const positionalDefs = this.arguments.filter(arg => arg.names.every(n => !n.startsWith('-')));
        const optionalDefs = this.arguments.filter(arg => arg.names.some(n => n.startsWith('-')));

        let i = 0;
        while (i < argv.length) {
            const token = argv[i];

            if (token === '-h' || token === '--help') {
                args.help = true;
                i++;
                continue;
            }

            if (token === '--version' || token === '-v') {
                args.version = true;
                i++;
                continue;
            }

            let matchedOpt = false;
            for (const opt of optionalDefs) {
                if (opt.names.includes(token)) {
                    matchedOpt = true;
                    const destName = opt.dest || opt.names.find(n => n.startsWith('--'))?.replace(/^--/, '').replace(/-/g, '_') || opt.names[0].replace(/^-+/, '');
                    
                    if (opt.action === 'store_true') {
                        args[destName] = true;
                    } else if (opt.action === 'append') {
                        if (!args[destName]) args[destName] = [];
                        if (i + 1 < argv.length) {
                            args[destName].push(argv[i + 1]);
                            i++;
                        }
                    } else {
                        if (i + 1 < argv.length) {
                            args[destName] = argv[i + 1];
                            i++;
                        }
                    }
                    break;
                }
            }

            if (!matchedOpt) {
                if (token.startsWith('-')) {
                    unknown.push(token);
                } else {
                    positionals.push(token);
                }
            }
            i++;
        }

        let posIndex = 0;
        for (const def of positionalDefs) {
            const destName = def.names[0];
            if (def.nargs === '?' || def.nargs === '0..1') {
                if (posIndex < positionals.length) {
                    args[destName] = positionals[posIndex++];
                } else {
                    args[destName] = def.default !== undefined ? def.default : null;
                }
            } else if (def.nargs === '*') {
                args[destName] = positionals.slice(posIndex);
                posIndex = positionals.length;
            } else {
                if (posIndex < positionals.length) {
                    args[destName] = positionals[posIndex++];
                } else {
                    args[destName] = def.default !== undefined ? def.default : null;
                }
            }
        }

        if (posIndex < positionals.length) {
            if (args.login_cmd !== undefined) {
                args.login_cmd = positionals.slice(posIndex);
            } else if (args.run_args !== undefined) {
                args.run_args = positionals.slice(posIndex);
            } else {
                unknown.push(...positionals.slice(posIndex));
            }
        }

        return { args, unknown };
    }
}

const REQUIRED_ARGS = {
    "install": [["image_ref", "Docker image reference is not specified (e.g. 'ubuntu:24.04')."]],
    "remove": [["target", "container name is not specified."]],
    "rename": [["orig_name", "the original container name is not specified."], ["new_name", "the new container name is not specified."]],
    "reset": [["container_name", "container name is not specified."]],
    "login": [["container_name", "container name is not specified."]],
    "backup": [["container_name", "container name is not specified."]],
    "copy": [["source", "source path is not specified."], ["destination", "destination path is not specified."]],
    "sync": [["source", "source path is not specified."], ["destination", "destination path is not specified."]],
    "run": [["container_name", "container name is not specified."]],
    "push": [["image_ref", "image reference is not specified (e.g. 'myrepo/myapp:1.0')."]],
    "search": [["query", "search query is not specified (e.g. 'ubuntu')."]],
};

function required_args_for(canonical, args) {
    if (canonical === "remove" && args.image) {
        return [["target", "image reference is not specified (e.g. 'ubuntu:24.04')."]];
    }
    return REQUIRED_ARGS[canonical] || [];
}

const ALIAS_TO_CANONICAL = {
    "add": "install",
    "i": "install",
    "in": "install",
    "ins": "install",
    "rm": "remove",
    "sh": "login",
    "li": "list",
    "ls": "list",
    "bak": "backup",
    "bkp": "backup",
    "clear": "clear-cache",
    "cl": "clear-cache",
    "cp": "copy",
    "s": "search",
    "se": "search",
    "h": "help",
    "he": "help",
    "hel": "help",
};

function _add_login_or_run_common(p) {
    p.add_argument("-u", "--user", { default: "root" });
    const _ports = p.add_mutually_exclusive_group();
    _ports.add_argument("-P", "--redirect-ports", { dest: "redirect_ports", action: "store_true" });
    if (p.prog.endsWith("login")) {
        _ports.add_argument("--fix-low-ports", { dest: "redirect_ports", action: "store_true" });
    }
    if (IS_TERMUX) {
        const _iso = p.add_mutually_exclusive_group();
        _iso.add_argument("--isolated", { action: "store_true" });
        _iso.add_argument("--minimal", { action: "store_true" });
        const _sh = p.add_mutually_exclusive_group();
        _sh.add_argument("--shared-home", { dest: "shared_home", action: "store_true" });
        _sh.add_argument("--termux-home", { dest: "shared_home", action: "store_true" });
    }
    p.add_argument("--shared-tmp", { dest: "shared_tmp", action: "store_true" });
    p.add_argument("--shared-x11", { dest: "shared_x11", action: "store_true" });
    p.add_argument("-b", "--bind", { action: "append", metavar: "PATH[:PATH]" });
    if (IS_TERMUX) {
        p.add_argument("--no-link2symlink", { dest: "no_link2symlink", action: "store_true" });
    }
    p.add_argument("--no-sysvipc", { dest: "no_sysvipc", action: "store_true" });
    p.add_argument("--no-kill-on-exit", { dest: "no_kill_on_exit", action: "store_true" });
    p.add_argument("--emulator", { dest: "emulator", metavar: "PATH" });
    p.add_argument("--kernel", { metavar: "STRING" });
    p.add_argument("--hostname", { metavar: "STRING" });
    p.add_argument("-w", "--work-dir", { dest: "work_dir", metavar: "PATH" });
    p.add_argument("-e", "--env", { action: "append", metavar: "VAR=VALUE" });
    p.add_argument("-d", "--detach", { action: "store_true" });
}

function build_parser() {
    const parser = new PdArgumentParser({
        prog: PROGRAM_NAME,
        description: "Manage Linux proot containers.",
    });
    parser.add_argument("-h", "--help", { action: "store_true" });
    parser.add_argument("--version", "-v", { action: "store_true" });
    const sub = parser.add_subparsers({ dest: "command" });
    sub.add_parser("help", { aliases: ["hel", "he", "h"] });
    _install(sub);
    _search(sub);
    _remove(sub);
    _rename(sub);
    _reset(sub);
    _login(sub);
    _list(sub);
    _backup(sub);
    _restore(sub);
    _clear_cache(sub);
    _copy(sub);
    _sync(sub);
    _build(sub);
    _push(sub);
    _run(sub);
    _ps(sub);
    _kill(sub);
    return parser;
}

function _install(sub) {
    const p = sub.add_parser("install", { aliases: ["add", "i", "in", "ins"] });
    p._pd_command = "install";
    p.add_argument("image_ref", { nargs: "?", default: null, metavar: "IMAGE" });
    const name_grp = p.add_mutually_exclusive_group();
    name_grp.add_argument("-n", "--name", { dest: "custom_container_name", metavar: "ALIAS" });
    name_grp.add_argument("--override-alias", { dest: "custom_container_name", metavar: "ALIAS" });
    p.add_argument("-a", "--architecture", { dest: "override_arch", metavar: "ARCH" });
    p.add_argument("--allow-insecure", { dest: "allow_insecure", action: "store_true" });
    p.add_argument("-q", "--quiet", { action: "store_true" });
    p.add_argument("-h", "--help", { action: "store_true" });
    p.add_argument("--version", "-v", { action: "store_true" });
}

function _search(sub) {
    const p = sub.add_parser("search", { aliases: ["se", "s"] });
    p._pd_command = "search";
    p.add_argument("query", { nargs: "?", default: null, metavar: "QUERY" });
    p.add_argument("-l", "--limit", { metavar: "N" });
    p.add_argument("-q", "--quiet", { action: "store_true" });
    p.add_argument("-h", "--help", { action: "store_true" });
    p.add_argument("--version", "-v", { action: "store_true" });
}

function _remove(sub) {
    const p = sub.add_parser("remove", { aliases: ["rm"] });
    p._pd_command = "remove";
    p.add_argument("target", { nargs: "?", default: null, metavar: "CONTAINER|IMAGE" });
    p.add_argument("-i", "--image", { action: "store_true" });
    p.add_argument("-a", "--architecture", { dest: "override_arch", metavar: "ARCH" });
    const vq = p.add_mutually_exclusive_group();
    vq.add_argument("-v", "--verbose", { action: "store_true" });
    vq.add_argument("-q", "--quiet", { action: "store_true" });
    p.add_argument("-h", "--help", { action: "store_true" });
    p.add_argument("--version", { action: "store_true" });
}

function _rename(sub) {
    const p = sub.add_parser("rename");
    p._pd_command = "rename";
    p.add_argument("orig_name", { nargs: "?", default: null });
    p.add_argument("new_name", { nargs: "?", default: null });
    p.add_argument("-q", "--quiet", { action: "store_true" });
    p.add_argument("-h", "--help", { action: "store_true" });
    p.add_argument("--version", "-v", { action: "store_true" });
}

function _reset(sub) {
    const p = sub.add_parser("reset");
    p._pd_command = "reset";
    p.add_argument("container_name", { nargs: "?", default: null });
    p.add_argument("-q", "--quiet", { action: "store_true" });
    p.add_argument("-h", "--help", { action: "store_true" });
    p.add_argument("--version", "-v", { action: "store_true" });
}

function _login(sub) {
    const p = sub.add_parser("login", { aliases: ["sh"] });
    p._pd_command = "login";
    p.add_argument("container_name", { nargs: "?", default: null });
    _add_login_or_run_common(p);
    p.add_argument("--get-proot-cmd", { dest: "get_proot_cmd", action: "store_true" });
    p.add_argument("login_cmd", { nargs: "*" });
    p.add_argument("-h", "--help", { action: "store_true" });
    p.add_argument("--version", "-v", { action: "store_true" });
}

function _list(sub) {
    const p = sub.add_parser("list", { aliases: ["li", "ls"] });
    p._pd_command = "list";
    p.add_argument("-i", "--image", { action: "store_true" });
    p.add_argument("-h", "--help", { action: "store_true" });
    p.add_argument("-q", "--quiet", { action: "store_true" });
    p.add_argument("--version", "-v", { action: "store_true" });
}

function _backup(sub) {
    const p = sub.add_parser("backup", { aliases: ["bak", "bkp"] });
    p._pd_command = "backup";
    p.add_argument("container_name", { nargs: "?", default: null });
    p.add_argument("-o", "--output", { metavar: "FILE" });
    p.add_argument("-c", "--compress", { dest: "compression", choices: ["gzip", "bzip2", "xz", "zstd", "none"], metavar: "TYPE" });
    const vq = p.add_mutually_exclusive_group();
    vq.add_argument("-v", "--verbose", { action: "store_true" });
    vq.add_argument("-q", "--quiet", { action: "store_true" });
    p.add_argument("-h", "--help", { action: "store_true" });
    p.add_argument("--version", { action: "store_true" });
}

function _restore(sub) {
    const p = sub.add_parser("restore");
    p._pd_command = "restore";
    p.add_argument("archive", { nargs: "?" });
    const vq = p.add_mutually_exclusive_group();
    vq.add_argument("-v", "--verbose", { action: "store_true" });
    vq.add_argument("-q", "--quiet", { action: "store_true" });
    p.add_argument("-h", "--help", { action: "store_true" });
    p.add_argument("--version", { action: "store_true" });
}

function _clear_cache(sub) {
    const p = sub.add_parser("clear-cache", { aliases: ["clear", "cl"] });
    p._pd_command = "clear-cache";
    p.add_argument("--orphan", { action: "store_true" });
    p.add_argument("--build-cache", { dest: "build_cache", action: "store_true" });
    const vq = p.add_mutually_exclusive_group();
    vq.add_argument("-v", "--verbose", { action: "store_true" });
    vq.add_argument("-q", "--quiet", { action: "store_true" });
    p.add_argument("-h", "--help", { action: "store_true" });
    p.add_argument("--version", { action: "store_true" });
}

function _copy(sub) {
    const p = sub.add_parser("copy", { aliases: ["cp"] });
    p._pd_command = "copy";
    p.add_argument("source", { nargs: "?", default: null });
    p.add_argument("destination", { nargs: "?", default: null });
    const vq = p.add_mutually_exclusive_group();
    vq.add_argument("-v", "--verbose", { action: "store_true" });
    vq.add_argument("-q", "--quiet", { action: "store_true" });
    p.add_argument("-m", "--move", { action: "store_true" });
    p.add_argument("-r", "--recursive", { action: "store_true" });
    p.add_argument("-h", "--help", { action: "store_true" });
    p.add_argument("--version", { action: "store_true" });
}

function _sync(sub) {
    const p = sub.add_parser("sync");
    p._pd_command = "sync";
    p.add_argument("source", { nargs: "?", default: null });
    p.add_argument("destination", { nargs: "?", default: null });
    const vq = p.add_mutually_exclusive_group();
    vq.add_argument("-v", "--verbose", { action: "store_true" });
    vq.add_argument("-q", "--quiet", { action: "store_true" });
    p.add_argument("-c", "--checksum", { action: "store_true" });
    p.add_argument("-d", "--delete", { action: "store_true" });
    p.add_argument("-h", "--help", { action: "store_true" });
    p.add_argument("--version", "-v", { action: "store_true" });
}

function _build(sub) {
    const p = sub.add_parser("build");
    p._pd_command = "build";
    p.add_argument("path", { nargs: "?", default: ".", metavar: "PATH" });
    p.add_argument("-f", "--file", { dest: "dockerfile", metavar: "PATH" });
    p.add_argument("-t", "--tag", { dest: "tags", action: "append", default: [], metavar: "REF" });
    p.add_argument("--build-arg", { dest: "build_args", action: "append", default: [], metavar: "K=V" });
    p.add_argument("-a", "--architecture", { dest: "override_arch", metavar: "ARCH" });
    p.add_argument("--target", { dest: "target_stage", metavar: "STAGE" });
    p.add_argument("--emulator", { dest: "emulator", metavar: "PATH" });
    p.add_argument("-o", "--output", { dest: "outputs", action: "append", default: [], metavar: "FILE" });
    p.add_argument("--install-as", { dest: "install_as", metavar: "NAME" });
    p.add_argument("--no-cache", { dest: "no_cache", action: "store_true" });
    const vq = p.add_mutually_exclusive_group();
    vq.add_argument("-v", "--verbose", { action: "store_true" });
    vq.add_argument("-q", "--quiet", { action: "store_true" });
    p.add_argument("-h", "--help", { action: "store_true" });
    p.add_argument("--version", { action: "store_true" });
}

function _push(sub) {
    const p = sub.add_parser("push");
    p._pd_command = "push";
    p.add_argument("image_ref", { nargs: "?", default: null, metavar: "IMAGE" });
    p.add_argument("-a", "--architecture", { dest: "override_arch", metavar: "ARCH" });
    p.add_argument("--allow-insecure", { dest: "allow_insecure", action: "store_true" });
    p.add_argument("-q", "--quiet", { action: "store_true" });
    p.add_argument("-h", "--help", { action: "store_true" });
    p.add_argument("--version", "-v", { action: "store_true" });
}

function _run(sub) {
    const p = sub.add_parser("run");
    p._pd_command = "run";
    p.add_argument("container_name", { nargs: "?", default: null });
    _add_login_or_run_common(p);
    p.add_argument("--get-proot-cmd", { action: "store_true" });
    p.add_argument("-h", "--help", { action: "store_true" });
    p.add_argument("--version", "-v", { action: "store_true" });
}

function _ps(sub) {
    const p = sub.add_parser("ps");
    p._pd_command = "ps";
    p.add_argument("-q", "--quiet", { action: "store_true" });
    p.add_argument("-h", "--help", { action: "store_true" });
    p.add_argument("--version", "-v", { action: "store_true" });
}

function _kill(sub) {
    const p = sub.add_parser("kill");
    p._pd_command = "kill";
    p.add_argument("target", { nargs: "?", default: null, metavar: "PID|CONTAINER" });
    p.add_argument("-s", "--signal", { metavar: "SIGNAL" });
    p.add_argument("--all", { action: "store_true" });
    p.add_argument("-h", "--help", { action: "store_true" });
    p.add_argument("--version", "-v", { action: "store_true" });
}

module.exports = {
    PdArgumentParser,
    build_parser,
    required_args_for,
    ALIAS_TO_CANONICAL,
    VERSION,
};
