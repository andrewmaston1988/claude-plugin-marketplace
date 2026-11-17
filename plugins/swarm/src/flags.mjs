// `--name value`, and nothing else: the flag reader every command module shares.
export function getFlag(name, args) {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1];
}
