(function () {
  const logos = __SWARM_LOGO_SVGS__;
  const escapeAttr = (value) => String(value).replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function providerLogo(provider, { label } = {}) {
    const key = String(provider ?? "").toLowerCase();
    const source = logos[key === "anthropic" ? "claude" : key];
    if (!source) return "";
    const attrs = label === undefined ? 'class="plogo" aria-hidden="true"' : `class="plogo" role="img" aria-label="${escapeAttr(label)}"`;
    return source.trim().replace(/<title>[\s\S]*?<\/title>\s*/i, "").replace(/fill="#000"/g, 'fill="currentColor"').replace(/^<svg\b/, `<svg ${attrs}`);
  }
  window.swarmLogos = { providerLogo };
})();
