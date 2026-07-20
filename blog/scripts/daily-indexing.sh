#!/bin/zsh
# Daily GSC indexing submission for aidemo.top (landing + blog).
# Runs at 10:00 via launchd (com.aidemo.seo-indexing) — uses Claude + Chrome
# to submit URLs to Google Search Console URL Inspection, 5 new submissions +
# 3 indexed-yet? re-checks per day (GSC quota is ~10-12/day per property).
#
# Adapted from the proven maxfit/burnweek versions (private repos). This repo
# is public, so the ntfy notification topic is env-injected by the launchd
# plist (NTFY_ANALYTICS_TOPIC) — never hardcoded here. Without it the script
# still runs; it just logs instead of notifying.
set -euo pipefail

cd /Users/tandryukha/demo-engine

NTFY_TOPIC="${NTFY_ANALYTICS_TOPIC:-}"
LOG="${LOG:-$HOME/Library/Logs/aidemo/seo-indexing.log}"
mkdir -p "$(dirname "$LOG")"
STATE_FILE="blog/data/seo/indexing-state.json"
URL_FILE="blog/data/seo/indexing-urls.txt"
VERIFIED_FLAG="blog/data/seo/gsc-property-verified"
REPORT_FILE="/tmp/aidemo-indexing-report.json"
PROGRESS_FILE="/tmp/aidemo-indexing-progress.json"
SITEMAP_URLS=("https://aidemo.top/sitemap.xml" "https://aidemo.top/blog/sitemap.xml")
PROPERTY="aidemo.top"
INSPECT_URL="https://search.google.com/search-console/inspect?resource_id=sc-domain%3Aaidemo.top"

echo "=== $(date) ===" >> "$LOG"

# Notification helpers: reuse the maxfit lib when present, minimal fallbacks
# otherwise. With no NTFY_TOPIC, notifications become silent no-ops.
NOTIFY_LIB="/Users/tandryukha/dropshipping-irondust/scripts/admin/notify-lib.sh"
if [ -f "$NOTIFY_LIB" ]; then
    # shellcheck disable=SC1090
    source "$NOTIFY_LIB"
    notify_init
else
    notify_online() { curl -sS --max-time 3 -o /dev/null "https://1.1.1.1" 2>/dev/null; }
    ntfy_post() { curl -sS --max-time 10 "$@" > /dev/null 2>&1 || true; }
fi
if [ -z "$NTFY_TOPIC" ]; then
    ntfy_post() { :; }
fi

notify_online || { echo "$(date) skip: laptop offline" >> "$LOG"; exit 0; }

# --- Preflight checks ---

if [ ! -f "$VERIFIED_FLAG" ]; then
    echo "$(date) skip: property not verified yet (touch $VERIFIED_FLAG once GSC ownership is confirmed)" >> "$LOG"
    ntfy_post -d "aidemo GSC indexing is waiting for property verification. See blog/data/seo/." \
        -H "Title: aidemo GSC Indexing — awaiting verification" \
        -H "Priority: low" -H "Tags: hourglass_flowing_sand" "https://ntfy.sh/$NTFY_TOPIC"
    exit 0
fi

if ! pgrep -q "Google Chrome"; then
    echo "$(date) skip: Chrome not running" >> "$LOG"
    exit 0
fi

if [ ! -f "$STATE_FILE" ]; then
    echo '{"submitted":[],"last_run":null,"total_submitted":0,"total_indexed":0}' > "$STATE_FILE"
fi

# --- Refresh the URL queue from the live sitemaps (root + blog) ---
# New articles/pages published after the initial seed get appended so the
# queue never goes stale. Failures are non-fatal.
for SITEMAP_URL in "${SITEMAP_URLS[@]}"; do
    SITEMAP_URL="$SITEMAP_URL" URL_FILE="$URL_FILE" python3 - << 'PY' >> "$LOG" 2>&1 || true
import os, re, urllib.request
url_file = os.environ['URL_FILE']
try:
    xml = urllib.request.urlopen(os.environ['SITEMAP_URL'], timeout=15).read().decode()
except Exception as e:
    print(f'sitemap refresh skipped ({os.environ["SITEMAP_URL"]}): {e}')
    raise SystemExit(0)
live = re.findall(r'<loc>([^<]+)</loc>', xml)
with open(url_file) as f:
    known = {l.strip() for l in f if l.strip() and not l.strip().startswith('#')}
fresh = [u for u in live if u not in known]
if fresh:
    with open(url_file, 'a') as f:
        for u in fresh:
            f.write(u + '\n')
    print(f'sitemap refresh: appended {len(fresh)} new URLs from {os.environ["SITEMAP_URL"]}')
PY
done

# --- Build URL lists ---
#   * SUBMIT — up to 5 never-submitted URLs from the queue.
#   * CHECK — up to 3 previously-submitted-but-unindexed URLs, rotated
#     oldest-checked-first; dead-ends (404/redirect after 4 tries) skipped.
CHECK_GIVEUP_ATTEMPTS=4

SELECTION=$(CHECK_GIVEUP_ATTEMPTS="$CHECK_GIVEUP_ATTEMPTS" STATE_FILE="$STATE_FILE" URL_FILE="$URL_FILE" python3 << 'PY'
import json, os
GIVEUP = int(os.environ['CHECK_GIVEUP_ATTEMPTS'])
with open(os.environ['STATE_FILE']) as f:
    state = json.load(f)

DEADEND_STATUSES = ('404', 'not found', 'page with redirect', 'redirect')

def is_deadend(e):
    if e.get('skip_recheck'):
        return True
    status = (e.get('last_status') or e.get('status') or '').lower()
    attempts = e.get('check_attempts', 0)
    return attempts >= GIVEUP and any(s in status for s in DEADEND_STATUSES)

submitted = state.get('submitted', [])
submitted_set = {e['url'] for e in submitted}

pending = [e for e in submitted if not e.get('indexed', False) and not is_deadend(e)]
pending.sort(key=lambda e: (e.get('last_checked') or '', e.get('date') or ''))
check_urls = [e['url'] for e in pending[:3]]

try:
    with open(os.environ['URL_FILE']) as f:
        all_urls = [l.strip() for l in f if l.strip() and not l.strip().startswith('#')]
except FileNotFoundError:
    all_urls = []
submit_urls = [u for u in all_urls if u not in submitted_set][:5]

total_pending = len([e for e in submitted if not e.get('indexed', False)])
deadends = len([e for e in submitted if not e.get('indexed', False) and is_deadend(e)])
print('CHECK\t' + '\t'.join(check_urls))
print('SUBMIT\t' + '\t'.join(submit_urls))
print('STATS\t%d\t%d\t%d' % (total_pending, deadends, len(submit_urls)))
PY
)

CHECK_URLS=$(printf '%s\n' "$SELECTION" | awk -F'\t' '/^CHECK/{for(i=2;i<=NF;i++) if($i!="") print $i}')
SUBMIT_URLS=$(printf '%s\n' "$SELECTION" | awk -F'\t' '/^SUBMIT/{for(i=2;i<=NF;i++) if($i!="") print $i}')
PENDING_TOTAL=$(printf '%s\n' "$SELECTION" | awk -F'\t' '/^STATS/{print $2}')

if [ -z "$SUBMIT_URLS" ] && [ -z "$CHECK_URLS" ]; then
    MSG="aidemo GSC Indexing: nothing to do — no new URLs and all ${PENDING_TOTAL:-0} pending URLs are permanent dead-ends. Add candidates to $URL_FILE to resume."
    echo "$MSG" >> "$LOG"
    ntfy_post -d "$MSG" -H "Title: aidemo GSC Indexing Complete" -H "Priority: default" \
        -H "Tags: white_check_mark" "https://ntfy.sh/$NTFY_TOPIC"
    exit 0
fi

HAD_WORK=1

CHECK_LIST=""
if [ -n "$CHECK_URLS" ]; then
    CHECK_LIST="PHASE 1 — CHECK these previously submitted URLs (verify if indexed now):
$(echo "$CHECK_URLS" | while read -r url; do echo "- $url"; done)

For each URL:
1. Click the search bar at the top (\"Inspect any URL in $PROPERTY\")
2. Select all text (Cmd+A), type the URL, press Enter
3. Wait 5 seconds for results to load
4. Read the page — look for \"URL is on Google\" (indexed=true) or \"URL is not on Google\" (indexed=false)
5. Record the result
"
fi

SUBMIT_LIST=""
if [ -n "$SUBMIT_URLS" ]; then
    SUBMIT_LIST="PHASE 2 — SUBMIT these new URLs for indexing:
$(echo "$SUBMIT_URLS" | while read -r url; do echo "- $url"; done)

For each URL:
1. Click the search bar at the top (\"Inspect any URL in $PROPERTY\")
2. Select all text (Cmd+A), type the URL, press Enter
3. Wait 5 seconds for results to load
4. Look for \"REQUEST INDEXING\" link/button and click it
5. Wait up to 15 seconds — a dialog will appear saying \"Testing if live URL can be indexed\"
6. If you see \"Quota Exceeded\" — STOP IMMEDIATELY, do not try more URLs, set quota_hit=true
7. If you see \"Indexing requested successfully\" or similar success — record success=true
8. If you see any other error — record success=false with the error
"
fi

# --- Run Claude with Chrome ---

rm -f "$PROGRESS_FILE"

PROMPT="You are automating Google Search Console URL Inspection for $PROPERTY.
You will work in the GSC URL Inspection page. First, get tab context, then create a new tab and navigate to:
$INSPECT_URL

IMPORTANT RULES:
- After the first navigation, CONFIRM the page header/search bar says \"Inspect any URL in \\\"$PROPERTY\\\"\". If instead you see a property picker, a different property, or a \"verify ownership\" screen, the $PROPERTY property is not accessible in this Chrome profile — write the progress file with an \"error\" key describing what you saw and STOP. Do not touch any other property.
- After EACH navigation/action, take a screenshot to verify the state
- Always wait 5 seconds after pressing Enter for URL inspection results
- If you see \"Quota Exceeded\" at ANY point, STOP all submissions immediately, update the progress file with quota_hit=true, and exit
- Work through URLs one at a time, sequentially

PROGRESSIVE CHECKPOINTING (CRITICAL — do not skip):
1. At the START, use the Write tool to create $PROGRESS_FILE with:
   {\"checked\":[],\"submitted\":[],\"quota_hit\":false}
2. After EACH URL you process (whether it succeeded, failed, or you hit an error), use Write to overwrite $PROGRESS_FILE with the updated data. Never skip a write — even if the URL failed.
3. This file is your authoritative output. Keep it valid JSON with exactly those three keys at all times (an extra \"error\" key is allowed when something goes wrong).
4. ENTRY SHAPES (strict): every element of \"checked\" MUST be an object {\"url\": \"...\", \"indexed\": true|false, \"status\": \"short status text\"} and every element of \"submitted\" MUST be an object {\"url\": \"...\", \"success\": true|false, \"error\": \"optional\"}. Never write bare URL strings into either array. URLs from PHASE 2 go in \"submitted\" only — do not duplicate them into \"checked\".

$CHECK_LIST
$SUBMIT_LIST

When all URLs are processed (or quota hit), make sure $PROGRESS_FILE reflects the final state, then output a short confirmation message."

echo "Running Claude with Chrome automation..." >> "$LOG"
echo "Check URLs: $(echo "$CHECK_URLS" | grep -c . || true)" >> "$LOG"
echo "Submit URLs: $(echo "$SUBMIT_URLS" | grep -c . || true)" >> "$LOG"

CLAUDE_EXIT=0
CLAUDE_RESULT=$(claude -p "$PROMPT" \
    --chrome \
    --permission-mode bypassPermissions \
    --allowedTools "mcp__claude-in-chrome__*,Read,Write" \
    --max-budget-usd 10.00 \
    --model sonnet \
    --output-format json \
    2>> "$LOG") || CLAUDE_EXIT=$?

# --- Transient usage/rate-limit: skip cleanly, state NOT advanced ---
if printf '%s' "$CLAUDE_RESULT" | grep -qiE "hit your (sonnet|opus|haiku|claude|usage) limit|\"api_error_status\":[[:space:]]*429"; then
    RESET=$(printf '%s' "$CLAUDE_RESULT" | grep -oE 'resets [^"]+' | head -1)
    MSG="aidemo GSC Indexing skipped — Claude usage limit reached (${RESET:-retry later}). State NOT advanced."
    echo "$MSG" >> "$LOG"
    ntfy_post -d "$MSG" -H "Title: aidemo GSC Indexing Skipped (rate limit)" -H "Priority: default" \
        -H "Tags: hourglass_flowing_sand" "https://ntfy.sh/$NTFY_TOPIC"
    exit 0
fi

if [ "$CLAUDE_EXIT" -ne 0 ]; then
    MSG="aidemo GSC Indexing: Claude failed — check $LOG"
    echo "Claude failed: $CLAUDE_RESULT" >> "$LOG"
    ntfy_post -d "$MSG" -H "Title: aidemo GSC Indexing Error" -H "Priority: high" \
        -H "Tags: x" "https://ntfy.sh/$NTFY_TOPIC"
    exit 1
fi

echo "Claude raw output: $CLAUDE_RESULT" >> "$LOG"

# Extract the JSON result: prefer the progress file, fall back to stdout parse.
REPORT=$(PROGRESS_FILE="$PROGRESS_FILE" python3 -c "
import sys, os, json, re

progress_path = os.environ.get('PROGRESS_FILE', '')

def fallback(reason):
    return '{\"checked\":[],\"submitted\":[],\"quota_hit\":false,\"error\":\"' + reason + '\"}'

if progress_path and os.path.exists(progress_path):
    try:
        with open(progress_path) as f:
            parsed = json.load(f)
        parsed.setdefault('checked', [])
        parsed.setdefault('submitted', [])
        parsed.setdefault('quota_hit', False)
        print(json.dumps(parsed))
        sys.exit(0)
    except Exception:
        pass

raw = sys.stdin.read().strip()
try:
    wrapper = json.loads(raw)
    text = wrapper.get('result', raw)
except:
    text = raw

m = re.search(r'<<<REPORT>>>\s*(\{.*?\})\s*<<<END>>>', text, re.DOTALL)
candidate = m.group(1) if m else None

if candidate is None:
    depth = 0
    start = -1
    candidates = []
    for i, ch in enumerate(text):
        if ch == '{':
            if depth == 0:
                start = i
            depth += 1
        elif ch == '}':
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    candidates.append(text[start:i+1])
                    start = -1
    for c in reversed(candidates):
        if '\"checked\"' in c:
            candidate = c
            break

if candidate is None:
    print(fallback('No progress file and no report JSON in output'))
else:
    try:
        parsed = json.loads(candidate)
        parsed.setdefault('checked', [])
        parsed.setdefault('submitted', [])
        parsed.setdefault('quota_hit', False)
        print(json.dumps(parsed))
    except Exception as e:
        print(fallback('Invalid JSON: ' + str(e).replace('\"', \"'\")))
" <<< "$CLAUDE_RESULT" 2>> "$LOG")

echo "$REPORT" > "$REPORT_FILE"
echo "Parsed report: $REPORT" >> "$LOG"

# --- A no-op must NOT report success (Chrome extension not connected etc.) ---
REPORT_EMPTY=$(echo "$REPORT" | python3 -c "
import sys, json
try:
    r = json.load(sys.stdin)
except Exception:
    print('1'); sys.exit(0)
empty = (len(r.get('checked', [])) == 0 and len(r.get('submitted', [])) == 0)
print('1' if empty else '0')
" 2>/dev/null || echo "1")

CHROME_DISCONNECTED=0
if echo "$CLAUDE_RESULT" | grep -qiE "Chrome browser extension isn't connected|extension needs to be active|extension.*not.*connected"; then
    CHROME_DISCONNECTED=1
fi

if [ "${HAD_WORK:-0}" = "1" ] && [ "$CHROME_DISCONNECTED" = "1" ]; then
    echo "$(date) skip: Chrome extension not connected — state not advanced" >> "$LOG"
    exit 0
fi

if [ "${HAD_WORK:-0}" = "1" ] && [ "$REPORT_EMPTY" = "1" ]; then
    MSG="aidemo GSC Indexing: empty report (0 checked, 0 submitted) despite queued work — Chrome automation likely couldn't run. State NOT advanced. Check $REPORT_FILE and $LOG."
    echo "$MSG" >> "$LOG"
    ntfy_post -d "$MSG" -H "Title: aidemo GSC Indexing — empty result" -H "Priority: low" \
        -H "Tags: warning" "https://ntfy.sh/$NTFY_TOPIC"
    exit 1
fi

# --- Update state file ---
STATE_FILE="$STATE_FILE" REPORT_FILE="$REPORT_FILE" python3 << 'PY' >> "$LOG" 2>&1 || echo "State update failed, continuing to notification" >> "$LOG"
import json, os
from datetime import date

with open(os.environ['STATE_FILE']) as f:
    state = json.load(f)
with open(os.environ['REPORT_FILE']) as f:
    report = json.load(f)

today = date.today().isoformat()
state['last_run'] = today

GIVEUP = 4
DEADEND_STATUSES = ('404', 'not found', 'page with redirect', 'redirect')

submitted_map = {e['url']: e for e in state['submitted']}
for checked in report.get('checked', []):
    # Tolerate bare-string entries despite the prompt's shape contract — a
    # sub-agent once wrote plain URLs here and crashed this whole block.
    if isinstance(checked, str):
        checked = {'url': checked}
    url = checked['url']
    if url not in submitted_map:
        continue
    entry = submitted_map[url]
    entry['indexed'] = checked.get('indexed', False)
    entry['last_checked'] = today
    entry['check_attempts'] = entry.get('check_attempts', 0) + 1
    status = checked.get('status') or checked.get('note') or ''
    if status:
        entry['last_status'] = status
    if checked.get('indexed'):
        entry['indexed_date'] = today
        entry.pop('skip_recheck', None)
    else:
        low = status.lower()
        if entry['check_attempts'] >= GIVEUP and any(s in low for s in DEADEND_STATUSES):
            entry['skip_recheck'] = True

for sub in report.get('submitted', []):
    if isinstance(sub, str):
        sub = {'url': sub, 'success': True}
    url = sub['url']
    if url not in submitted_map and sub.get('success'):
        submitted_map[url] = {'url': url, 'date': today, 'indexed': False}

state['submitted'] = list(submitted_map.values())
state['total_submitted'] = len(state['submitted'])
state['total_indexed'] = len([e for e in state['submitted'] if e.get('indexed')])

with open(os.environ['STATE_FILE'], 'w') as f:
    json.dump(state, f, indent=2)

print(f'Updated state: {state["total_submitted"]} submitted, {state["total_indexed"]} indexed')
PY

# --- Send ntfy notification ---

CHECKED_COUNT=$(echo "$REPORT" | python3 -c "import sys,json; r=json.load(sys.stdin); print(len(r.get('checked',[])))" 2>/dev/null || echo "0")
INDEXED_COUNT=$(echo "$REPORT" | python3 -c "import sys,json; r=json.load(sys.stdin); print(len([c for c in r.get('checked',[]) if isinstance(c,dict) and c.get('indexed')]))" 2>/dev/null || echo "0")
SUBMITTED_COUNT=$(echo "$REPORT" | python3 -c "import sys,json; r=json.load(sys.stdin); print(len([s for s in r.get('submitted',[]) if isinstance(s,dict) and s.get('success')]))" 2>/dev/null || echo "0")
QUOTA_HIT=$(echo "$REPORT" | python3 -c "import sys,json; r=json.load(sys.stdin); print('Yes' if r.get('quota_hit') else 'No')" 2>/dev/null || echo "?")
URL_FILE_COUNT=$(python3 -c "print(sum(1 for l in open('$URL_FILE') if l.strip() and not l.strip().startswith('#')))" 2>/dev/null || echo "?")
TOTAL_STATE=$(URL_FILE_COUNT="$URL_FILE_COUNT" STATE_FILE="$STATE_FILE" python3 -c "import os,json; s=json.load(open(os.environ['STATE_FILE'])); print(f\"{s['total_submitted']}/{os.environ['URL_FILE_COUNT']} submitted, {s['total_indexed']} indexed\")" 2>/dev/null || echo "unknown")

MSG="Checked: $CHECKED_COUNT ($INDEXED_COUNT newly indexed)
Submitted: $SUBMITTED_COUNT new URLs
Quota hit: $QUOTA_HIT
Progress: $TOTAL_STATE"

echo "Report: $MSG" >> "$LOG"
ntfy_post \
    -d "$MSG" \
    -H "Title: aidemo GSC Indexing Report" \
    -H "Priority: default" \
    -H "Tags: mag" \
    "https://ntfy.sh/$NTFY_TOPIC"

echo "Done at $(date)" >> "$LOG"
