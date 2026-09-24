import { Result, Schema } from "effect";

const SweepResultSchema = Schema.Struct({
  found: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  killed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  survivors: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const decodeWorkspaceWriterSweep = Schema.decodeUnknownResult(
  Schema.fromJsonString(SweepResultSchema),
  { onExcessProperty: "error" },
);

// The root is supplied as bash's first positional argument. The script never embeds session data.
export const workspaceWriterSweepScript = `# scotty_workspace_writer_sweep
root=\${1%/}
[[ $root == /* ]] || exit 2
[[ -d /proc/1 ]] || exit 2
command -v find >/dev/null || exit 2
# Run from / so this script's own subshells never hold the workspace as cwd.
cd / || exit 2
declare -A protected=()
p=$$
while [[ $p =~ ^[0-9]+$ ]] && (( p > 0 )); do
  protected[$p]=1
  (( p == 1 )) && break
  parent=0
  while read -r key value rest; do
    if [[ $key == PPid: ]]; then parent=$value; break; fi
  done < "/proc/$p/status" || exit 2
  p=$parent
done
# One find pass matches cwd, exe, and open-fd symlink targets without forking per link.
scan() {
  writers=()
  local seen=" " pid
  while IFS=/ read -r _ _ pid _; do
    [[ \${protected[$pid]+yes} ]] && continue
    [[ $seen == *" $pid "* ]] && continue
    seen+="$pid "
    writers+=("$pid")
  done < <(find /proc -mindepth 2 -maxdepth 3 \\( -path '/proc/[0-9]*/cwd' -o -path '/proc/[0-9]*/exe' -o -path '/proc/[0-9]*/fd/*' \\) \\( -lname "$root" -o -lname "$root/*" \\) -print 2>/dev/null)
}
scan
found=\${#writers[@]}
for pid in "\${writers[@]}"; do kill -TERM "$pid" 2>/dev/null || :; done
stop_at=$((SECONDS + 3))
until (( SECONDS >= stop_at )); do
  scan
  (( \${#writers[@]} == 0 )) && break
  sleep 0.2
done
for pid in "\${writers[@]}"; do kill -KILL "$pid" 2>/dev/null || :; done
scan
for pid in "\${writers[@]}"; do kill -KILL "$pid" 2>/dev/null || :; done
scan
survivors=\${#writers[@]}
killed=$(( found > survivors ? found - survivors : 0 ))
printf '{"found":%d,"killed":%d,"survivors":%d}\\n' "$found" "$killed" "$survivors"`;

export const workspaceWriterSweepSurvived = (output: string): boolean | "invalid" => {
  const decoded = decodeWorkspaceWriterSweep(output.trim());
  return Result.isSuccess(decoded) ? decoded.success.survivors > 0 : "invalid";
};
