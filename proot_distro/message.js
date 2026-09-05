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
 * # Architecture: ANSI color constants and a minimal msg() helper. Colors are
 * # enabled only when stderr is a TTY and PD_FORCE_NO_COLORS is unset. The C
 * # dict maps symbolic names to escape sequences so callers don't deal with
 * # raw ANSI codes. Every entry starts with _RST so transitions implicitly
 * # reset attributes.
 */

const os = require('os');

let termios = null;
try {
    termios = require('termios');
} catch (e) {
    termios = null;
}

const _RST = "\x1b[0m";
const _BOLD = "\x1b[1m";
const _ITALIC = "\x1b[3m";
const _UNDERLINE = "\x1b[4m";
const _RED = "\x1b[31m";
const _GREEN = "\x1b[32m";
const _YELLOW = "\x1b[33m";
const _BLUE = "\x1b[34m";
const _MAGENTA = "\x1b[35m";
const _CYAN = "\x1b[36m";
const _WHITE = "\x1b[37m";

const _COLORS = {
    "RST": _RST,
    "RED": _RST + _RED,
    "BRED": _RST + _BOLD + _RED,
    "IRED": _RST + _ITALIC + _RED,
    "URED": _RST + _UNDERLINE + _RED,
    "UBRED": _RST + _UNDERLINE + _BOLD + _RED,
    "GREEN": _RST + _GREEN,
    "BGREEN": _RST + _BOLD + _GREEN,
    "IGREEN": _RST + _ITALIC + _GREEN,
    "UGREEN": _RST + _UNDERLINE + _GREEN,
    "UBGREEN": _RST + _UNDERLINE + _BOLD + _GREEN,
    "YELLOW": _RST + _YELLOW,
    "BYELLOW": _RST + _BOLD + _YELLOW,
    "IYELLOW": _RST + _ITALIC + _YELLOW,
    "UYELLOW": _RST + _UNDERLINE + _YELLOW,
    "UBYELLOW": _RST + _UNDERLINE + _BOLD + _YELLOW,
    "BLUE": _RST + _BLUE,
    "BBLUE": _RST + _BOLD + _BLUE,
    "IBLUE": _RST + _ITALIC + _BLUE,
    "UBLUE": _RST + _UNDERLINE + _BLUE,
    "UBBLUE": _RST + _UNDERLINE + _BOLD + _BLUE,
    "MAGENTA": _RST + _MAGENTA,
    "BMAGENTA": _RST + _BOLD + _MAGENTA,
    "IMAGENTA": _RST + _ITALIC + _MAGENTA,
    "UMAGENTA": _RST + _UNDERLINE + _MAGENTA,
    "UBMAGENTA": _RST + _UNDERLINE + _BOLD + _MAGENTA,
    "CYAN": _RST + _CYAN,
    "BCYAN": _RST + _BOLD + _CYAN,
    "ICYAN": _RST + _ITALIC + _CYAN,
    "UCYAN": _RST + _UNDERLINE + _CYAN,
    "UBCYAN": _RST + _UNDERLINE + _BOLD + _CYAN,
    "WHITE": _RST + _WHITE,
    "BWHITE": _RST + _BOLD + _WHITE,
    "IWHITE": _RST + _ITALIC + _WHITE,
    "UWHITE": _RST + _UNDERLINE + _WHITE,
    "UBWHITE": _RST + _UNDERLINE + _BOLD + _WHITE,
};

const _EMPTY = Object.fromEntries(Object.keys(_COLORS).map(k => [k, ""]));

function _init_colors() {
    if (process.stderr.isTTY && !process.env.PD_FORCE_NO_COLORS) {
        return _COLORS;
    }
    return _EMPTY;
}

const C = _init_colors();

function tty_safe_for_writes() {
    if (termios === null) return true;
    try {
        const fd = process.stderr.fd;
        if (!process.stderr.isTTY) return true;
        const attrs = termios.tcgetattr(fd);
        if (!attrs) return true;
        const lflag = attrs[3];
        // ECHO is usually bit 0x8 or similar depending on platform, but without a dedicated termios library in pure node, we approximate or fallback.
        // Since termios in Node usually requires a native module, we handle it gracefully if available.
        return true;
    } catch (e) {
        return true;
    }
}

function terminal_width(defaultValue = 80) {
    for (const stream of [process.stderr, process.stdout]) {
        try {
            if (stream.columns && stream.columns > 0) {
                return stream.columns;
            }
        } catch (e) {
            continue;
        }
    }
    return defaultValue;
}

let _quiet = false;

function set_quiet(value) {
    _quiet = Boolean(value);
}

function is_quiet() {
    return _quiet;
}

function msg(...args) {
    if (!tty_safe_for_writes()) return;
    let is_tty = false;
    try {
        is_tty = Boolean(process.stderr.isTTY);
    } catch (e) {
        is_tty = false;
    }

    if (is_tty) {
        process.stderr.write("\r\x1b[K");
    }
    console.error(...args);
}

function log_info(text) {
    if (_quiet) return;
    msg(`${C['BLUE']}[${C['GREEN']}*{C['BLUE']}] ${C['CYAN']}${text}${C['RST']}`);
}

function log_error(text) {
    msg(`${C['BLUE']}[${C['RED']}!{C['BLUE']}] ${C['CYAN']}${text}${C['RST']}`);
}

function warn(text) {
    msg(`${C['BYELLOW']}Warning: ${C['YELLOW']}${text}${C['RST']}`);
}

function crit_error(text) {
    msg(`${C['BRED']}Error: ${C['RED']}${text}${C['RST']}`);
}

const _QUOTE_MAP = {
    "\\": "\\\\",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
    "\x1b": "\\e",
};

function quote_path(text) {
    let out = [];
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const escaped = _QUOTE_MAP[ch];
        if (escaped !== undefined) {
            out.push(escaped);
        } else if (ch < " " || ch === "\x7f") {
            out.push(`\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
        } else {
            out.push(ch);
        }
    }
    return out.join("");
}

function quote_error(exc) {
    const strerror = exc.strerror || exc.message || String(exc);
    return quote_path(strerror);
}

module.exports = {
    C,
    tty_safe_for_writes,
    terminal_width,
    set_quiet,
    is_quiet,
    msg,
    log_info,
    log_error,
    warn,
    crit_error,
    quote_path,
    quote_error,
};
