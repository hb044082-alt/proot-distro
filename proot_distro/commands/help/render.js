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
 * # Architecture: Layout primitives for the help renderer. The page data
 * # is a plain JS object (see pages.js); this module is pure formatting
 * # — wraps paragraphs, renders the [usage]/[options]/[examples] sections,
 * # and switches between a stacked-vertical layout on narrow PTYs and a
 * # two-column layout on wider screens.
 */

const os = require('os');
const {
    PROGRAM_NAME,
    CANONICAL_PROGRAM_NAME,
    PROGRAM_AUTHOR,
    PROGRAM_VERSION,
} = require('../constants');
const { C, msg } = require('../message');

const _MIN_WIDTH = 32;
const _MAX_WIDTH = 92;
const NARROW_BREAKPOINT = 60;
const _RULE_SINGLE = "─";
const _BULLET = "▸";
const _PROMPT = "$";

function term_width() {
    for (const fd of [2, 1, 0]) {
        try {
            let cols = 0;
            if (fd === 2 && process.stderr.columns) cols = process.stderr.columns;
            else if (fd === 1 && process.stdout.columns) cols = process.stdout.columns;
            if (cols > 0) {
                return Math.max(_MIN_WIDTH, Math.min(_MAX_WIDTH, cols));
            }
        } catch (e) {
            continue;
        }
    }

    try {
        const cols = parseInt(process.env.COLUMNS || "0", 10);
        if (cols > 0) {
            return Math.max(_MIN_WIDTH, Math.min(_MAX_WIDTH, cols));
        }
    } catch (e) {}

    return Math.max(_MIN_WIDTH, Math.min(_MAX_WIDTH, 72));
}

function _wrap(text, width) {
    width = Math.max(4, width);
    if (!text) return [""];
    
    const words = text.split(/\s+/);
    const lines = [];
    let currentLine = "";

    for (const word of words) {
        if (currentLine === "") {
            currentLine = word;
        } else if (currentLine.length + 1 + word.length <= width) {
            currentLine += " " + word;
        } else {
            lines.push(currentLine);
            currentLine = word;
        }
    }
    if (currentLine !== "") {
        lines.push(currentLine);
    }
    return lines.length > 0 ? lines : [""];
}

function _hrule(width, char, color = null) {
    return `${color || C['CYAN']}${char.repeat(width)}${C['RST']}`;
}

function section(label) {
    msg();
    msg(`${C['UBCYAN']}${label}${C['RST']}`);
    msg();
}

function paragraph(text, width, indent = 2, color = null) {
    color = color || C["CYAN"];
    const pad = " ".repeat(indent);
    const avail = Math.max(8, width - indent);
    const paragraphs = text.split("\n\n");

    for (let i = 0; i < paragraphs.length; i++) {
        if (i > 0) {
            msg();
        }
        const lines = _wrap(paragraphs[i], avail);
        for (const line of lines) {
            msg(`${pad}${color}${line}${C['RST']}`);
        }
    }
}

function usage_line(usage, width) {
    const parts = usage.split(" ", 2);
    const sub = parts[0];
    const rest = parts.length > 1 ? parts[1] : "";
    const head = `${C['BGREEN']}${PROGRAM_NAME}${C['RST']} ${C['UGREEN']}${sub}${C['RST']}`;
    const head_visible = 2 + PROGRAM_NAME.length + 1 + sub.length;

    if (!rest) {
        msg(` ${head}`);
        return;
    }
    if (head_visible + 1 + rest.length <= width) {
        msg(` ${head} ${C['CYAN']}${rest}${C['RST']}`);
        return;
    }
    msg(` ${head}`);
    const cont = " ";
    const lines = _wrap(rest, width - cont.length);
    for (const line of lines) {
        msg(`${cont}${C['CYAN']}${line}${C['RST']}`);
    }
}

function aliases_block(aliases) {
    const sep = `${C['CYAN']}, ${C['RST']}`;
    const parts = aliases.map(a => `${C['UGREEN']}${a}${C['RST']}`);
    msg(` ${C['CYAN']}Aliases:${C['RST']} ${parts.join(sep)}`);
}

function _options_stacked(options, width) {
    const last = options.length - 1;
    for (let i = 0; i < options.length; i++) {
        const [name, desc] = options[i];
        msg(` ${C['GREEN']}${name}${C['RST']}`);
        paragraph(desc, width, 4);
        if (i !== last) {
            msg();
        }
    }
}

function options_block(options, width) {
    if (!options || options.length === 0) return;
    if (width < NARROW_BREAKPOINT) {
        _options_stacked(options, width);
        return;
    }
    const longest = Math.max(...options.map(([name]) => name.length));
    const opt_col = Math.min(longest, Math.max(16, Math.floor(width / 3)));
    const desc_col = width - opt_col - 4;
    if (desc_col < 24) {
        _options_stacked(options, width);
        return;
    }
    const cont = " ".repeat(2 + opt_col + 2);
    const last = options.length - 1;

    for (let i = 0; i < options.length; i++) {
        const [name, desc] = options[i];
        const wrapped = _wrap(desc, desc_col);
        if (name.length <= opt_col) {
            const head = ` ${C['GREEN']}${name}${C['RST']}${" ".repeat(opt_col - name.length)} ${C['CYAN']}${wrapped[0]}${C['RST']}`;
            msg(head);
            for (let j = 1; j < wrapped.length; j++) {
                msg(`${cont}${C['CYAN']}${wrapped[j]}${C['RST']}`);
            }
        } else {
            msg(` ${C['GREEN']}${name}${C['RST']}`);
            for (const line of wrapped) {
                msg(`${cont}${C['CYAN']}${line}${C['RST']}`);
            }
        }
        if (i !== last) {
            msg();
        }
    }
}

function commands_block(commands, width) {
    if (!commands || commands.length === 0) return;
    const longest = Math.max(...commands.map(entry => entry[0].length));
    const name_col = Math.min(longest, Math.max(12, Math.floor(width / 4)));
    const desc_col = width - name_col - 4;
    const narrow = width < NARROW_BREAKPOINT || desc_col < 24;

    if (narrow) {
        const last = commands.length - 1;
        for (let i = 0; i < commands.length; i++) {
            const entry = commands[i];
            const name = entry[0];
            const desc = entry[1];
            const warn = entry.length > 2 ? entry[2] : null;
            msg(` ${C['GREEN']}${name}${C['RST']}`);
            paragraph(desc, width, 4);
            if (warn) {
                msg(` ${C['RED']}${warn}${C['RST']}`);
            }
            if (i !== last) {
                msg();
            }
        }
        return;
    }

    const cont = " ".repeat(2 + name_col + 2);
    for (let i = 0; i < commands.length; i++) {
        const entry = commands[i];
        const name = entry[0];
        const desc = entry[1];
        const warn = entry.length > 2 ? entry[2] : null;
        const wrapped = _wrap(desc, desc_col);
        const head = ` ${C['GREEN']}${name}${C['RST']}${" ".repeat(name_col - name.length)} ${C['CYAN']}${wrapped[0]}${C['RST']}`;

        if (warn && wrapped.length === 1 && wrapped[0].length + 1 + warn.length <= desc_col) {
            msg(`${head} ${C['RED']}${warn}${C['RST']}`);
            continue;
        }
        msg(head);
        for (let j = 1; j < wrapped.length; j++) {
            msg(`${cont}${C['CYAN']}${wrapped[j]}${C['RST']}`);
        }
        if (warn) {
            msg(`${cont}${C['RED']}${warn}${C['RST']}`);
        }
    }
}

function shell_block(examples, width) {
    const avail = Math.max(12, width - 4);
    const wrap_avail = Math.max(4, avail - 2);
    for (const ex of examples) {
        const wrapped = _wrap(ex, wrap_avail);
        const last = wrapped.length - 1;
        for (let i = 0; i < wrapped.length; i++) {
            const line = wrapped[i];
            const suffix = i === last ? "" : ` ${C['CYAN']}\\${C['RST']}`;
            if (i === 0) {
                msg(` ${C['YELLOW']}${_PROMPT}${C['RST']} ${C['GREEN']}${line}${C['RST']}${suffix}`);
            } else {
                msg(` ${C['GREEN']}${line}${C['RST']}${suffix}`);
            }
        }
    }
}

function bullets_block(bullets, width) {
    if (!bullets || bullets.length === 0) return;
    const longest = Math.max(...bullets.map(([label]) => label.length));
    const name_col = Math.min(longest, Math.max(16, Math.floor(width / 3)));
    const desc_col = width - 4 - name_col - 2;
    const narrow = width < NARROW_BREAKPOINT || desc_col < 16;

    if (narrow) {
        for (const [label, comment] of bullets) {
            msg(` ${C['CYAN']}${_BULLET}${C['RST']} ${C['YELLOW']}${label}${C['RST']}`);
            if (comment) {
                paragraph(`(${comment})`, width, 6);
            }
        }
        return;
    }

    const cont = " ".repeat(4 + name_col + 2);
    for (const [label, comment] of bullets) {
        const pad = " ".repeat(Math.max(0, name_col - label.length));
        if (comment) {
            const wrapped = _wrap(`(${comment})`, desc_col);
            msg(` ${C['CYAN']}${_BULLET}${C['RST']} ${C['YELLOW']}${label}${C['RST']}${pad} ${C['CYAN']}${wrapped[0]}${C['RST']}`);
            for (let j = 1; j < wrapped.length; j++) {
                msg(`${cont}${C['CYAN']}${wrapped[j]}${C['RST']}`);
            }
        } else {
            msg(` ${C['CYAN']}${_BULLET}${C['RST']} ${C['YELLOW']}${label}${C['RST']}`);
        }
    }
}

function footer(width) {
    msg();
    msg(_hrule(width, _RULE_SINGLE, C["CYAN"]));
    paragraph(
        `${CANONICAL_PROGRAM_NAME} version '${PROGRAM_VERSION}' by ${PROGRAM_AUTHOR}.`,
        width,
        0,
        C["ICYAN"]
    );
    msg();
}

function render_page(page) {
    const width = term_width();
    if (page.usage) {
        section("USAGE");
        usage_line(page.usage, width);
    }
    if (page.aliases) {
        msg();
        aliases_block(page.aliases);
    }
    if (page.summary) {
        section("DESCRIPTION");
        paragraph(page.summary, width);
    }
    if (page.options) {
        section("OPTIONS");
        options_block(page.options, width);
    }
    if (page.examples) {
        section("EXAMPLES");
        shell_block(page.examples, width);
    }
    if (page.footer) {
        for (const block of page.footer) {
            if (block.title) {
                section(block.title);
            }
            if (block.intro) {
                paragraph(block.intro, width);
            }
            if (block.bullets) {
                if (block.intro) {
                    msg();
                }
                bullets_block(block.bullets, width);
            }
            if (block.examples) {
                if (block.intro || block.bullets) {
                    msg();
                }
                shell_block(block.examples, width);
            }
        }
    }
    footer(width);
}

module.exports = {
    term_width,
    section,
    paragraph,
    usage_line,
    aliases_block,
    options_block,
    commands_block,
    shell_block,
    bullets_block,
    footer,
    render_page,
};
