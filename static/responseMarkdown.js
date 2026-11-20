(function(root) {
  "use strict";
  function escape(text) { return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
  function safeUrl(raw) {
    var url = String(raw).replace(/^sandbox:\s*/, "");
    return /^(https?:\/\/|\/api\/artifacts\/|\/artifacts\/)/i.test(url) ? escape(url) : "";
  }
  function inline(raw) {
    var saved = [];
    function hold(html) { saved.push(html); return "\u0001" + (saved.length - 1) + "\u0002"; }
    var text = String(raw).replace(/\u0001|\u0002/g, "");
    text = text.replace(/`([^`\n]+)`/g, function(_, code) { return hold("<code>" + escape(code) + "</code>"); });
    text = text.replace(/(!?)\[([^\]\n]*)\]\(\s*([^\s)]+)\s*\)/g, function(_, image, label, rawUrl) {
      var url = safeUrl(rawUrl);
      if (!url) return label;
      return hold(image ? '<a href="' + url + '" target="_blank" rel="noopener noreferrer"><img loading="lazy" src="' + url + '" alt="' + escape(label) + '"></a>' : '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + escape(label) + '</a>');
    });
    text = text.replace(/(?:sandbox:\s*)?\/(?:api\/)?artifacts\/[A-Za-z0-9._%/-]+\.(?:png|jpe?g|webp|gif)\b/gi, function(url) {
      var safe = safeUrl(url);
      return hold('<a href="' + safe + '" target="_blank" rel="noopener noreferrer"><img loading="lazy" src="' + safe + '" alt="Generated image"></a>');
    });
    text = escape(text).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|\W)\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
    return text.replace(/\u0001(\d+)\u0002/g, function(_, id) { return saved[Number(id)]; });
  }
  function format(raw) {
    var lines = String(raw || "").replace(/\r\n?/g, "\n").split("\n"), output = [], i = 0;
    function listMatch(line) { return /^(\s*)(?:([-*+•])|((?:\d+)[.)]))\s+(.+)$/.exec(line); }
    function tableRule(line) { return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line); }
    function cells(line) { return line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(function(cell) { return cell.trim().replace(/\\\|/g,"|"); }); }
    function isBlock(line, next) { return /^\s*(?:`{3,}|~{3,}|#{1,6}\s|>\s?|(?:[-*_]\s*){3,}$)/.test(line) || listMatch(line) || (next && tableRule(next)); }
    function list(indent) {
      var first = listMatch(lines[i]), ordered = Boolean(first[3]), tag = ordered ? "ol" : "ul";
      var start = ordered ? parseInt(first[3], 10) : 1;
      var html = "<" + tag + (ordered && start !== 1 ? ' start="' + start + '"' : "") + ">";
      while (i < lines.length) {
        var item = listMatch(lines[i]);
        if (!item || item[1].length !== indent || Boolean(item[3]) !== ordered) break;
        var itemText = item[4]; i++;
        while (i < lines.length && lines[i].trim() && !listMatch(lines[i]) && /^\s+/.test(lines[i]) && !isBlock(lines[i],lines[i+1])) itemText += " " + lines[i++].trim();
        html += "<li>" + inline(itemText);
        while (i < lines.length && listMatch(lines[i]) && listMatch(lines[i])[1].length > indent) html += list(listMatch(lines[i])[1].length);
        html += "</li>";
        // A blank line may separate items in the same list.
        if (!String(lines[i] || "").trim() && lines[i+1] && listMatch(lines[i+1]) && listMatch(lines[i+1])[1].length === indent) i++;
      }
      return html + "</" + tag + ">";
    }
    while (i < lines.length) {
      if (!lines[i].trim()) { i++; continue; }
      var line = lines[i], fence = /^\s*(`{3,}|~{3,})([^\s]*)\s*$/.exec(line);
      if (fence) {
        var code = [], marker = fence[1][0], count = fence[1].length;
        i++;
        while (i < lines.length && !(new RegExp("^\\s*" + marker + "{" + count + ",}\\s*$")).test(lines[i])) code.push(lines[i++]);
        if (i < lines.length) i++;
        output.push('<div class="code-block"><div class="code-header"><span>' + escape(fence[2] || "Code") + '</span><button type="button" class="copy-code" aria-label="Copy code">Copy code</button></div><pre><code>' + escape(code.join("\n")) + '</code></pre></div>');
        continue;
      }
      var heading = /^\s*#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(line);
      if (heading) { var level = Math.min(3, line.trim().match(/^#+/)[0].length); output.push("<h"+level+">"+inline(heading[1])+"</h"+level+">"); i++; continue; }
      if (i+1 < lines.length && line.includes("|") && tableRule(lines[i+1])) {
        var headers = cells(line), rows = []; i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(cells(lines[i++]));
        output.push('<div class="reply-table" role="region" aria-label="Response table" tabindex="0"><table><thead><tr>' + headers.map(function(cell) { return "<th scope=\"col\">"+inline(cell)+"</th>"; }).join("") + "</tr></thead><tbody>" + rows.map(function(row) { return "<tr>"+headers.map(function(_,index) { return "<td>"+inline(row[index]||"")+"</td>"; }).join("")+"</tr>"; }).join("")+"</tbody></table></div>"); continue;
      }
      if (/^\s*>/.test(line)) {
        var quote=[]; while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/,""));
        output.push("<blockquote>"+format(quote.join("\n"))+"</blockquote>"); continue;
      }
      if (listMatch(line)) { output.push(list(listMatch(line)[1].length)); continue; }
      if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) { output.push("<hr>"); i++; continue; }
      var paragraph=[line]; i++;
      while (i < lines.length && lines[i].trim() && !isBlock(lines[i],lines[i+1])) paragraph.push(lines[i++]);
      // Soft line wrapping belongs to layout. Only explicit Markdown hard breaks create <br>.
      output.push("<p>"+paragraph.map(function(part,index) { return inline(part.trimEnd()) + (index < paragraph.length-1 ? (/ {2,}$/.test(part) ? "<br>" : " ") : ""); }).join("")+"</p>");
    }
    return '<div class="reply-content">'+output.join("")+"</div>";
  }
  root.OpenBotsMarkdown = {format: format};
})(typeof globalThis !== "undefined" ? globalThis : window);
