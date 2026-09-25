// The one source of a run's derived leaf ids: forEach clones and child-manifest tasks.
export const cloneId = (base, i) => `${base}[${i}]`;
export const childId = (node, id) => `${node}~${id}`;
