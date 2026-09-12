#!/usr/bin/env python3
"""One owned deployed Codex command/follow-up proof; stores only bounded metadata."""
import argparse
import datetime
import json
import pathlib
import subprocess
import time

p = argparse.ArgumentParser()
p.add_argument('--cli', required=True)
p.add_argument('--repo', required=True)
p.add_argument('--evidence', required=True)
p.add_argument('--authorize-create-and-cleanup', action='store_true', required=True)
a = p.parse_args()
root = pathlib.Path(a.evidence).resolve()
root.mkdir(parents=True, exist_ok=False)
session_id = None
create_attempted = False
records = []

def save():
    (root / 'proof.json').write_text(json.dumps(records, indent=2) + '\n')

def record(event, **fields):
    value = dict(event=event, at=datetime.datetime.now(datetime.timezone.utc).isoformat(), **fields)
    records.append(value)
    save()
    print(json.dumps(value), flush=True)

def cli(*args):
    try:
        r = subprocess.run([a.cli, *args], capture_output=True, text=True, timeout=360)
    except subprocess.TimeoutExpired:
        record('cli_timeout', command=args[0])
        raise RuntimeError('CLI timed out; inspect the exact owned session') from None
    if r.returncode:
        # Do not publish raw errors: they can include untrusted tool/model content.
        record('cli_failed', command=args[0], exit=r.returncode)
        raise RuntimeError('CLI failed; inspect the exact owned session or retained pending request')
    return json.loads(r.stdout)

def wait_for_turn(marker, minimum, expected_command, expected_output, expected_turn=None):
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        d = cli('inspect', session_id, '--json')
        turns = d.get('turns', [])
        if d.get('runtimeStopped') is not False or any(t.get('state') == 'failed' for t in turns):
            record('runtime_failed', session=session_id,
                   reason='stale_notification' if any('stale_notification' in t.get('activitySummary', '') for t in turns) else 'other')
            raise RuntimeError('Runtime failed')
        if len(turns) >= minimum and turns[-1].get('state') == 'completed':
            t = turns[-1]
            tools = t.get('tools', [])
            command_matched = any(
                x.get('state') == 'completed'
                and all(part in str(x.get('invocation', '')) for part in expected_command)
                and expected_output(str(x.get('output', '')))
                for x in tools)
            ok = (marker in str(t.get('assistant', ''))
                  and command_matched
                  and (expected_turn is None or t.get('id') == expected_turn))
            record('terminal', session=session_id, turn=t['id'], completed_tools=sum(x.get('state') == 'completed' for x in tools), command_matched=command_matched, marker=marker, marker_present=marker in str(t.get('assistant', '')), runtimeStopped=d.get('runtimeStopped'), followUpAvailable=d.get('followUpAvailable'))
            if not ok or d.get('followUpAvailable') is not True:
                raise RuntimeError('Missing matching completed turn, requested command, marker, or follow-up readiness')
            return t['id']
        time.sleep(2)
    raise RuntimeError('Terminal deadline exceeded')

try:
    build = cli('--build-info')
    doctor = cli('doctor', '--json')
    record('doctor', ok=doctor.get('ok'), host=doctor.get('host'), installation=doctor.get('installationName'), build_commit=build.get('commit'))
    if doctor.get('ok') is not True:
        raise RuntimeError('Doctor failed')
    prompt = 'Read-only verification. Run python3 -c \'print("x" * 70000)\' once without piping or truncating output. Do not change files, read credentials, or delegate. Then reply VERIFY_CODEX_OUTPUT_DONE.'
    create_attempted = True
    created = cli('beam', prompt, '--title', 'Codex verification skill proof ' + root.name, '--repo', a.repo, '--provider', 'cloudflare', '--agent', 'codex', '--detach', '--json')
    session_id = created['id']
    if session_id == '6ffa0a512819':
        session_id = None
        raise RuntimeError('Protected identity; stop')
    record('created', session=session_id, recipe='70000-byte-command-output', agent_override='codex', model_overrides=False)
    initial_turn = wait_for_turn(
        'VERIFY_CODEX_OUTPUT_DONE', 1, ('python3', 'print', '70000'),
        lambda output: len(output) >= 1200 and output[:1200] == 'x' * 1200)
    receipt = cli('steer', session_id, 'Run printf VERIFY_CODEX_FOLLOWUP_TOOL once, then reply VERIFY_CODEX_FOLLOWUP_DONE. Do not change files.', '--json')
    if not isinstance(receipt.get('turnId'), str) or not receipt['turnId'] or receipt['turnId'] == initial_turn:
        raise RuntimeError('Follow-up admission returned no distinct turn ID')
    record('followup_admitted', session=session_id, turn=receipt.get('turnId'), mode=receipt.get('mode'))
    wait_for_turn(
        'VERIFY_CODEX_FOLLOWUP_DONE', 2, ('printf', 'VERIFY_CODEX_FOLLOWUP_TOOL'),
        lambda output: 'VERIFY_CODEX_FOLLOWUP_TOOL' in output, receipt['turnId'])
except BaseException as error:
    record('run_failed', stage='drive', kind=type(error).__name__)
    raise
finally:
    if session_id:
        try:
            result = cli('vaporize', session_id, '--yes', '--json')
            record('cleanup', session=session_id, gone=result.get('status') == 'gone')
            if result.get('status') != 'gone':
                raise RuntimeError('Cleanup incomplete')
        except BaseException as error:
            record('cleanup_blocked', session=session_id, kind=type(error).__name__)
            raise
    else:
        record('cleanup', session=None, pending_create_requires_inspection=create_attempted)
record('feature_pass', feature='requested-large-command-and-terminal-followup', scope='deployed CLI only; native aggregate length, delegation and lifecycle not covered')
