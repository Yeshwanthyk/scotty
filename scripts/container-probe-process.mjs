export const observeChildExit = (child) => {
  let settled = false;
  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      settled = true;
      resolve({ code, signal });
    });
  });
  return { exit, isSettled: () => settled };
};

export const createJsonlAccumulator = () => {
  let remainder = "";
  return {
    push(chunk) {
      remainder += chunk.toString("utf8");
      const lines = remainder.split("\n");
      remainder = lines.pop() ?? "";
      return lines.filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
    },
    remainder: () => remainder,
  };
};

const within = async (promise, milliseconds) => {
  let timer;
  try {
    return await Promise.race([
      promise.then((value) => ({ settled: true, value })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ settled: false }), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

export const terminateObservedChild = async (
  child,
  observed,
  { termMilliseconds = 1_000, killMilliseconds = 1_000 } = {},
) => {
  if (observed.isSettled()) return observed.exit;
  child.kill("SIGTERM");
  const terminated = await within(observed.exit, termMilliseconds);
  if (terminated.settled) return terminated.value;
  child.kill("SIGKILL");
  const killed = await within(observed.exit, killMilliseconds);
  if (killed.settled) return killed.value;
  throw new Error("child did not exit after SIGTERM and SIGKILL");
};

export const containerProbeProcessSource = () =>
  `const within = ${within.toString()};\nconst observeChildExit = ${observeChildExit.toString()};\nconst terminateObservedChild = ${terminateObservedChild.toString()};\nconst createJsonlAccumulator = ${createJsonlAccumulator.toString()};`;
