// Direct port of C:/code/claude/scripts/md_to_slack.py
// Algorithm preserved exactly — see that file for authorship context.

function parseTableRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
}

function isSeparator(line) {
  return /^\|[\s:|-]+\|$/.test(line.trim());
}

export function hasTable(text) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].trim().startsWith("|") && isSeparator(lines[i + 1])) return true;
  }
  return false;
}

// Split a long text into ≤maxLen chunks at paragraph boundaries (blank lines).
// Shared by the bot conversation handler and the notify path — both want
// multi-message rendering for long content so Slack doesn't clip silently
// at its attachment-text cap. Originally lived in core/handler.mjs as a
// private helper; lifted here so notify/index.mjs can reuse identically.
export function splitResponse(text, maxLen = 3000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  const paras = text.split(/\n\n+/);
  let current = "";
  for (const para of paras) {
    if (current.length + para.length + 2 > maxLen) {
      if (current) chunks.push(current.trim());
      current = para.length > maxLen ? para.slice(0, maxLen) : para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text.slice(0, maxLen)];
}

function splitSegments(text) {
  const lines = text.split("\n");
  const segments = [];
  const buf = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim().startsWith("|") && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      if (buf.length) { segments.push(["text", buf.join("\n")]); buf.length = 0; }
      const table = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) { table.push(lines[i]); i++; }
      segments.push(["table", table.join("\n")]);
    } else {
      buf.push(lines[i]);
      i++;
    }
  }
  if (buf.length) segments.push(["text", buf.join("\n")]);
  return segments;
}

const LABEL_STYLE = { bold: true, underline: true };
const VALUE_STYLE = { italic: true };
const BOLD_PLACEHOLDER_RE = /^\x00BOLD\d+\x00$/;

function boldCell(cell, placeholders) {
  if (!cell) return cell;
  if (placeholders && BOLD_PLACEHOLDER_RE.test(cell.trim())) return cell;
  return `*${cell}*`;
}

function tableToRichTextBlocks(tableText) {
  const lines = tableText.trim().split("\n").filter(l => l.trim());
  if (lines.length < 3) return [];

  const headers = parseTableRow(lines[0]);
  const rows = lines.slice(2).filter(l => l.trim().startsWith("|")).map(l => parseTableRow(l));
  const firstIsIndex = /^#*\s*(?:no\.?|#|id)?$/i.test(headers[0]);

  const result = [];
  rows.forEach((row, rowIdx) => {
    while (row.length < headers.length) row.push("");

    const elements = [];
    let fieldPairs;

    if (firstIsIndex) {
      const idxVal = row[0];
      const dataH = headers.slice(1);
      const dataC = row.slice(1);
      if (dataC.length) {
        const title = dataC[0];
        elements.push({
          type: "rich_text_section",
          elements: [
            { type: "text", text: `#${idxVal} `, style: LABEL_STYLE },
            { type: "text", text: title, style: LABEL_STYLE },
          ],
        });
        fieldPairs = dataH.slice(1).map((h, i) => [h, dataC[i + 1] ?? ""]);
      } else {
        fieldPairs = [];
      }
    } else {
      fieldPairs = headers.map((h, i) => [h, row[i] ?? ""]);
    }

    for (const [h, c] of fieldPairs) {
      if (c && c !== "—" && c !== "-" && c !== "") {
        elements.push({
          type: "rich_text_section",
          elements: [
            { type: "text", text: `${h}:`, style: LABEL_STYLE },
            { type: "text", text: ` ${c}`, style: VALUE_STYLE },
          ],
        });
      }
    }

    if (elements.length) {
      result.push({ type: "rich_text", elements });
      if (rowIdx < rows.length - 1) result.push({ type: "divider" });
    }
  });

  return result;
}

function tablesToRecords(text, placeholders) {
  const lines = text.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim().startsWith("|") && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const headers = parseTableRow(lines[i]);
      i += 2;
      const firstIsIndex = /^#*\s*(?:no\.?|#|id)?$/i.test(headers[0]);

      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const cells = parseTableRow(lines[i]);
        while (cells.length < headers.length) cells.push("");

        let dataH, dataC, prefix;
        if (firstIsIndex) {
          const idxVal = cells[0];
          dataH = headers.slice(1);
          dataC = cells.slice(1);
          prefix = (idxVal && idxVal !== "—") ? `*#${idxVal}*` : "";
        } else {
          dataH = headers;
          dataC = cells;
          prefix = "";
        }

        if (dataC.length) {
          const title = dataC[0];
          const line1Parts = [prefix, title ? boldCell(title, placeholders) : ""].filter(Boolean);
          out.push(line1Parts.join(" "));
          for (let j = 1; j < dataH.length; j++) {
            const c = dataC[j];
            if (c && c !== "—") out.push(`  *${dataH[j]}:* ${c}`);
          }
        }
        out.push("");
        i++;
      }
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join("\n");
}

export function mdToBlocks(text) {
  if (!hasTable(text)) return null;
  const blocks = [];
  for (const [segType, content] of splitSegments(text)) {
    if (segType === "text") {
      const converted = mdToSlack(content).trim();
      if (!converted) continue;
      for (let i = 0; i < converted.length; i += 3000) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: converted.slice(i, i + 3000) } });
      }
    } else {
      blocks.push(...tableToRichTextBlocks(content));
    }
  }
  return blocks.length ? blocks : null;
}

const EMOJI_MAP = [
  ["✅", ":white_check_mark:"], ["✔", ":white_check_mark:"], ["✓", ":white_check_mark:"],
  ["✗", ":x:"], ["⚠️", ":warning:"], ["⚠", ":warning:"],
  ["🟢", ":large_green_circle:"], ["🟡", ":large_yellow_circle:"], ["🔴", ":red_circle:"],
  ["🚨", ":rotating_light:"], ["⏳", ":hourglass_flowing_sand:"], ["⚫", ":black_circle:"],
  ["📋", ":clipboard:"], ["🔀", ":twisted_rightwards_arrows:"], ["🔄", ":arrows_counterclockwise:"],
  ["🔨", ":hammer:"], ["🔬", ":microscope:"], ["🔸", ":small_orange_diamond:"],
  ["🔹", ":small_blue_diamond:"], ["🔺", ":small_red_triangle:"], ["🙋", ":raising_hand:"],
  ["🧪", ":test_tube:"], ["🔥", ":fire:"], ["🎖", ":medal:"], ["📢", ":loudspeaker:"],
  ["⁉️", ":interrobang:"], ["🌳", ":deciduous_tree:"], ["🌿", ":herb:"], ["🧬", ":dna:"],
  ["⚙️", ":gear:"], ["👥", ":busts_in_silhouette:"], ["🚧", ":construction:"],
  ["🩺", ":stethoscope:"], ["💡", ":bulb:"], ["💬", ":speech_balloon:"], ["⛔", ":no_entry:"],
  ["➡️", ":arrow_right:"], ["🔍", ":mag:"], ["🌟", ":star2:"],
];

const TYPOGRAPHY_MAP = [
  ["→", "->"], ["←", "<-"], ["↑", "^"], ["↓", "v"], ["»", ">>"], ["›", ">"],
  ["–", "-"], ["—", " — "], ["…", "..."], ["≤", "<="], ["≥", ">="],
  ["≈", "~"], ["×", "x"], ["÷", "/"], ["±", "+/-"],
];

export function mdToSlack(text) {
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const placeholders = {};
  let counter = 0;

  function protect(original) {
    const key = `\x00CODE${counter++}\x00`;
    placeholders[key] = original;
    return key;
  }

  function protectBold(content) {
    const key = `\x00BOLD${counter++}\x00`;
    placeholders[key] = `*${content}*`;
    return key;
  }

  // Step 1 — protect code blocks and inline code
  text = text.replace(/```[\s\S]*?```/g, m => protect(m));
  text = text.replace(/`[^`\n]+`/g, m => protect(m));

  // Step 2 — conversions
  // Headings → bold
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_, content) => protectBold(content));
  // List items → bullet
  text = text.replace(/^(\s*)[-*]\s+/gm, "$1• ");
  // Emoji substitutions
  for (const [from, to] of EMOJI_MAP) text = text.replaceAll(from, to);
  // Typography
  for (const [from, to] of TYPOGRAPHY_MAP) text = text.replaceAll(from, to);
  // Bold italic ***text***
  text = text.replace(/\*{3}(.+?)\*{3}/gs, (_, c) => `*_${c}_*`);
  // Bold **text** (protected)
  text = text.replace(/\*{2}(.+?)\*{2}/gs, (_, c) => protectBold(c));
  // Italic *text* (single, not at bold boundary)
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gs, "_$1_");
  // Strikethrough ~~text~~
  text = text.replace(/~~(.+?)~~/gs, "~$1~");
  // Links [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
  // Horizontal rules
  text = text.replace(/^\s*[-*_]{3,}\s*$/gm, "");
  // Tables → records
  text = tablesToRecords(text, placeholders);
  // Collapse 3+ blank lines
  text = text.replace(/\n{3,}/g, "\n\n");

  // Step 3 — restore protected regions (loop to handle nesting)
  for (let i = 0; i < 10; i++) {
    const prev = text;
    for (const [key, original] of Object.entries(placeholders)) {
      text = text.replaceAll(key, original);
    }
    if (text === prev) break;
  }

  return text.trim();
}
