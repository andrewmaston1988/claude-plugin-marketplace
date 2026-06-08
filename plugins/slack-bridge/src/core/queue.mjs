export function createQueue({ log }) {
  const workers = new Map(); // channel → Promise (tail of chain)

  function enqueue(channel, task) {
    const tail = (workers.get(channel) ?? Promise.resolve()).then(
      () => task().catch(e => log.error("queue task error", { channel, message: e.message }))
    );
    workers.set(channel, tail);
    // Clean up resolved chains to avoid Map growing indefinitely
    tail.then(() => { if (workers.get(channel) === tail) workers.delete(channel); });
  }

  return { enqueue };
}
