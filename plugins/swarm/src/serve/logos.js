(function () {
  const logos = __SWARM_LOGO_SVGS__;
  // The chip disc, its ring and the mark's colour, per provider — the operator's
  // design reference. The stored .svg files are never edited: the mark's own fill
  // is swapped to `mark` here, at render time, disc included.
  const discs = {
    claude: { disc: "#D97757", ring: "#b75e42", mark: "#fff" },
    codex: { disc: "#10A37F", ring: "#087f64", mark: "#fff" },
    ollama: { disc: "#fff", ring: "#d4d4d4", mark: "#000" },
  };
  const escapeAttr = (value) => String(value).replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function providerLogo(provider, { chip, label } = {}) {
    const name = String(provider ?? "").toLowerCase().replace(/^anthropic$/, "claude");
    const source = logos[name];
    if (!source) return "";
    const attrs = label === undefined ? 'aria-hidden="true"' : `role="img" aria-label="${escapeAttr(label)}"`;
    const bare = source.trim().replace(/<title>[\s\S]*?<\/title>\s*/i, "");
    if (chip) {
      // Shadow and pulse are CSS on .pdisc — a <filter> def per chip would duplicate
      // ids across every chip in the page. 48/64 is 75% of the disc, per the reference.
      const mark = bare.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "").replace(/fill="#(?:000|D97757)"/gi, `fill="${discs[name].mark}"`);
      return `<svg class="plogo pdisc" ${attrs} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="31" fill="${discs[name].disc}" stroke="${discs[name].ring}" stroke-width="2"/><g transform="translate(8 8) scale(0.1875)">${mark}</g></svg>`;
    }
    return bare.replace(/fill="#000"/g, 'fill="currentColor"').replace(/^<svg\b/, `<svg class="plogo" ${attrs}`);
  }
  window.swarmLogos = { providerLogo };
})();
