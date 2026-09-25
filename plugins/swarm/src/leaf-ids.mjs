// Run leaf ids and the shared forEach clone-id grammar.
export const DIGEST_ID = "__digest";
export const cloneId = (base, i) => `${base}[${i}]`;
export const childId = (node, id) => `${node}~${id}`;

export function parseCloneId(id) {
  const match = /^(.+)\[(\d+)\]$/.exec(id);
  return match ? { parent: match[1], index: match[2] } : null;
}
