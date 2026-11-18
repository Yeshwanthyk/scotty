export const serverReply: (method: string, id: string | number) => string = (method, id) => {
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  )
    return JSON.stringify({ id, result: { decision: "decline" } });
  if (method === "applyPatchApproval" || method === "execCommandApproval")
    return JSON.stringify({
      id,
      result: { decision: { denied: { rejection: "approval disabled" } } },
    });
  if (method === "item/permissions/requestApproval")
    return JSON.stringify({ id, result: { permissions: {}, scope: "turn" } });
  return JSON.stringify({
    id,
    error: {
      code: -32601,
      message: "method unavailable",
    },
  });
};
