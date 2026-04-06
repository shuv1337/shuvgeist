#!/usr/bin/env bash
# browser-benchmark.sh -- Performance comparison: shuvgeist vs agent-browser vs dev-browser
#
# Coverage:
# - navigation (simple + complex)
# - screenshot
# - page snapshot
# - JS eval (simple + extract)
# - tab listing
# - form fill
# - repeated extraction vs batch extraction
# - error path
# - shuvgeist-specific sidepanel-closed validation
# - shuvgeist-specific headless cold-start path
set -uo pipefail

WARMUP=${WARMUP:-2}
ITERATIONS=${ITERATIONS:-5}
COLD_ITERATIONS=${COLD_ITERATIONS:-3}
TEST_URL="https://example.com"
COMPLEX_URL="https://news.ycombinator.com"
RESULTS_DIR="/tmp/browser-benchmark-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RESULTS_DIR"

GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'
YELLOW='\033[0;33m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

FORM_URL=$(python3 - <<'PY'
import urllib.parse
html='''<!doctype html><html><body><main><h1>Form Benchmark</h1><form><label>Name <input id="name" aria-label="Name"></label><label>Email <input id="email" aria-label="Email"></label><label>City <input id="city" aria-label="City"></label><button type="submit">Submit</button></form></main></body></html>'''
print('data:text/html;charset=utf-8,' + urllib.parse.quote(html))
PY
)
MISSING_SELECTOR="#__definitely_missing_element__"

########################################################################
# Timing engine
########################################################################

time_cmd() {
  local key="$1"; shift
  local start end elapsed
  start=$(date +%s%N)
  eval "$@" >/dev/null 2>&1
  end=$(date +%s%N)
  elapsed=$(( (end - start) / 1000000 ))
  echo "$elapsed" >> "$RESULTS_DIR/${key}.raw"
}

time_cmd_success_required() {
  local key="$1"; shift
  local start end elapsed
  start=$(date +%s%N)
  if eval "$@" >/dev/null 2>&1; then
    end=$(date +%s%N)
    elapsed=$(( (end - start) / 1000000 ))
    echo "$elapsed" >> "$RESULTS_DIR/${key}.raw"
    return 0
  fi
  return 1
}

calc_stats() {
  local file="$1"
  local skip_lines="${2:-$WARMUP}"
  if [[ ! -f "$file" ]]; then echo "ERR ERR ERR ERR 0"; return; fi

  local all_vals
  all_vals=$(tail -n +"$((skip_lines + 1))" "$file" 2>/dev/null)
  if [[ -z "$all_vals" ]]; then echo "ERR ERR ERR ERR 0"; return; fi

  local sum=0 min=999999999 max=0 n=0
  while read -r v; do
    [[ -z "$v" ]] && continue
    sum=$((sum + v)); n=$((n + 1))
    (( v < min )) && min=$v
    (( v > max )) && max=$v
  done <<< "$all_vals"

  [[ $n -eq 0 ]] && { echo "ERR ERR ERR ERR 0"; return; }
  local mean=$((sum / n))

  local sq_sum=0
  while read -r v; do
    [[ -z "$v" ]] && continue
    local diff=$((v - mean))
    sq_sum=$((sq_sum + diff * diff))
  done <<< "$all_vals"
  local stddev
  stddev=$(echo "scale=0; sqrt($sq_sum / $n)" | bc 2>/dev/null || echo "0")

  echo "$mean $min $max $stddev $n"
}

########################################################################
# Helpers
########################################################################

print_stat_line() {
  local stats="$1"
  local mean min max stddev n
  read -r mean min max stddev n <<< "$stats"
  if [[ "$mean" == "ERR" ]]; then
    echo -e "${RED}FAILED${NC}"
  else
    printf "${GREEN}%5dms${NC} avg  ${DIM}(min=%d max=%d sd=%s n=%d)${NC}\n" "$mean" "$min" "$max" "$stddev" "$n"
  fi
}

status_has_sidepanel_only_caps() {
  shuvgeist status 2>/dev/null | grep -Eq 'session_history|session_inject|session_new|session_set_model|session_artifacts'
}

validate_sg_closed_sidepanel() {
  local status_text
  status_text=$(shuvgeist status 2>/dev/null || true)
  if ! echo "$status_text" | grep -q 'Extension connected: yes'; then
    echo "not-connected"
    return 1
  fi
  if echo "$status_text" | grep -Eq 'session_history|session_inject|session_new|session_set_model|session_artifacts'; then
    echo "sidepanel-open"
    return 1
  fi
  if shuvgeist snapshot --json >/dev/null 2>&1 && shuvgeist eval "document.title" >/dev/null 2>&1; then
    echo "validated"
    return 0
  fi
  echo "bridge-failed"
  return 1
}

########################################################################
# Pre-flight
########################################################################

echo ""
echo -e "${BOLD}=================================================================${NC}"
echo -e "${BOLD}  Browser Automation Benchmark${NC}"
echo -e "${BOLD}  shuvgeist vs agent-browser vs dev-browser${NC}"
echo -e "${BOLD}=================================================================${NC}"
echo ""
echo -e "  Warmup       : ${CYAN}${WARMUP} runs${NC} (discarded)"
echo -e "  Iterations   : ${CYAN}${ITERATIONS} runs${NC} (measured)"
echo -e "  Cold runs    : ${CYAN}${COLD_ITERATIONS}${NC} (headless launch)"
echo -e "  Results dir  : ${CYAN}${RESULTS_DIR}${NC}"
echo ""

SG_OK=0; AB_OK=0; DB_OK=0

echo -ne "  Checking shuvgeist ...     "
if shuvgeist status 2>&1 | grep -q "Extension connected: yes"; then
  SG_VER=$(shuvgeist --version 2>/dev/null || echo '?')
  echo -e "${GREEN}OK${NC} (v${SG_VER})"
  SG_OK=1
else
  echo -e "${RED}NOT CONNECTED${NC}"
fi

echo -ne "  Checking agent-browser ... "
if agent-browser session list >/dev/null 2>&1; then
  AB_VER=$(agent-browser --version 2>/dev/null || echo '?')
  echo -e "${GREEN}OK${NC} (v${AB_VER})"
  AB_OK=1
else
  echo -e "${RED}NOT AVAILABLE${NC}"
fi

echo -ne "  Checking dev-browser ...   "
if dev-browser status >/dev/null 2>&1; then
  DB_VER="dev-browser"
  echo -e "${GREEN}OK${NC}"
  DB_OK=1
else
  echo -e "${RED}NOT AVAILABLE${NC}"
fi

echo ""

if [[ $SG_OK -eq 0 && $AB_OK -eq 0 && $DB_OK -eq 0 ]]; then
  echo -e "${RED}No tools available. Exiting.${NC}"; exit 1
fi

########################################################################
# Pre-warm
########################################################################

echo -e "  ${DIM}Pre-warming all tools on ${TEST_URL} ...${NC}"
[[ $SG_OK -eq 1 ]] && shuvgeist navigate "$TEST_URL" >/dev/null 2>&1 || true
sleep 1
[[ $AB_OK -eq 1 ]] && agent-browser open "$TEST_URL" >/dev/null 2>&1 && agent-browser wait --load networkidle >/dev/null 2>&1
[[ $DB_OK -eq 1 ]] && dev-browser <<< "const p = await browser.getPage('bench'); await p.goto('$TEST_URL', {waitUntil:'domcontentloaded'}); console.log('ok')" >/dev/null 2>&1
[[ $SG_OK -eq 1 ]] && shuvgeist navigate "$COMPLEX_URL" >/dev/null 2>&1 || true
[[ $AB_OK -eq 1 ]] && agent-browser open "$COMPLEX_URL" >/dev/null 2>&1 && agent-browser wait --load networkidle >/dev/null 2>&1
[[ $DB_OK -eq 1 ]] && dev-browser <<< "const p = await browser.getPage('bench'); await p.goto('$COMPLEX_URL', {waitUntil:'domcontentloaded'}); console.log('ok')" >/dev/null 2>&1
echo ""

########################################################################
# Test definitions
########################################################################

TESTS=(
  navigate
  navigate_complex
  screenshot
  snapshot
  eval_simple
  eval_extract
  tabs_list
  form_fill
  repeated_extract
  batch_extract
  error_path
)

declare -A LABELS=(
  [navigate]="Navigate (simple)"
  [navigate_complex]="Navigate (complex)"
  [screenshot]="Screenshot"
  [snapshot]="Page snapshot"
  [eval_simple]="Eval: document.title"
  [eval_extract]="Eval: extract links"
  [tabs_list]="List tabs"
  [form_fill]="Form fill (3 fields)"
  [repeated_extract]="Repeated extract (5 calls)"
  [batch_extract]="Batch extract (1 call)"
  [error_path]="Error path (missing selector)"
)

########################################################################
# Command factories
########################################################################

sg_cmd() {
  case "$1" in
    navigate)         echo 'shuvgeist navigate "'"$TEST_URL"'"' ;;
    navigate_complex) echo 'shuvgeist navigate "'"$COMPLEX_URL"'"' ;;
    screenshot)       echo 'shuvgeist screenshot --out "'"$RESULTS_DIR"'/sg_shot.webp"' ;;
    snapshot)         echo 'shuvgeist snapshot --json' ;;
    eval_simple)      echo 'shuvgeist eval "document.title"' ;;
    eval_extract)     echo "shuvgeist eval 'JSON.stringify(Array.from(document.querySelectorAll(\"a\")).map(a=>a.href))'" ;;
    tabs_list)        echo 'shuvgeist tabs --json' ;;
    form_fill)        echo "shuvgeist navigate '$FORM_URL' && shuvgeist eval '(() => { document.querySelector(\"#name\").value = \"Ada\"; document.querySelector(\"#email\").value = \"ada@example.com\"; document.querySelector(\"#city\").value = \"London\"; return [document.querySelector(\"#name\").value, document.querySelector(\"#email\").value, document.querySelector(\"#city\").value].join(\"|\"); })()'" ;;
    repeated_extract) echo "shuvgeist navigate '$COMPLEX_URL' && shuvgeist eval 'document.querySelectorAll(\"a\")[0]?.textContent' && shuvgeist eval 'document.querySelectorAll(\"a\")[1]?.textContent' && shuvgeist eval 'document.querySelectorAll(\"a\")[2]?.textContent' && shuvgeist eval 'document.querySelectorAll(\"a\")[3]?.textContent' && shuvgeist eval 'document.querySelectorAll(\"a\")[4]?.textContent'" ;;
    batch_extract)    echo "shuvgeist navigate '$COMPLEX_URL' && shuvgeist eval 'JSON.stringify(Array.from(document.querySelectorAll(\"a\")).slice(0, 5).map((a) => a.textContent))'" ;;
    error_path)       echo "shuvgeist eval '(() => document.querySelector(\"$MISSING_SELECTOR\").value)()'" ;;
  esac
}

ab_cmd() {
  case "$1" in
    navigate)         echo 'agent-browser open "'"$TEST_URL"'"' ;;
    navigate_complex) echo 'agent-browser open "'"$COMPLEX_URL"'"' ;;
    screenshot)       echo 'agent-browser screenshot "'"$RESULTS_DIR"'/ab_shot.png"' ;;
    snapshot)         echo 'agent-browser snapshot -i --json' ;;
    eval_simple)      echo "agent-browser eval 'document.title'" ;;
    eval_extract)     echo "echo 'JSON.stringify(Array.from(document.querySelectorAll(\"a\")).map(a=>a.href))' | agent-browser eval --stdin" ;;
    tabs_list)        echo 'agent-browser session list' ;;
    form_fill)        echo "agent-browser open '$FORM_URL' && echo '(() => { document.querySelector(\"#name\").value = \"Ada\"; document.querySelector(\"#email\").value = \"ada@example.com\"; document.querySelector(\"#city\").value = \"London\"; return [document.querySelector(\"#name\").value, document.querySelector(\"#email\").value, document.querySelector(\"#city\").value].join(\"|\"); })()' | agent-browser eval --stdin" ;;
    repeated_extract) echo "agent-browser open '$COMPLEX_URL' && agent-browser eval 'document.querySelectorAll(\"a\")[0]?.textContent' && agent-browser eval 'document.querySelectorAll(\"a\")[1]?.textContent' && agent-browser eval 'document.querySelectorAll(\"a\")[2]?.textContent' && agent-browser eval 'document.querySelectorAll(\"a\")[3]?.textContent' && agent-browser eval 'document.querySelectorAll(\"a\")[4]?.textContent'" ;;
    batch_extract)    echo "agent-browser open '$COMPLEX_URL' && echo 'JSON.stringify(Array.from(document.querySelectorAll(\"a\")).slice(0, 5).map((a) => a.textContent))' | agent-browser eval --stdin" ;;
    error_path)       echo "echo '(() => document.querySelector(\"$MISSING_SELECTOR\").value)()' | agent-browser eval --stdin" ;;
  esac
}

db_cmd() {
  case "$1" in
    navigate)         echo "dev-browser <<< 'const p = await browser.getPage(\"bench\"); await p.goto(\"$TEST_URL\", {waitUntil:\"domcontentloaded\"}); console.log(\"ok\")'" ;;
    navigate_complex) echo "dev-browser <<< 'const p = await browser.getPage(\"bench\"); await p.goto(\"$COMPLEX_URL\", {waitUntil:\"domcontentloaded\"}); console.log(\"ok\")'" ;;
    screenshot)       echo "dev-browser <<< 'const p = await browser.getPage(\"bench\"); const buf = await p.screenshot(); const path = await saveScreenshot(buf, \"db_shot.png\"); console.log(path)'" ;;
    snapshot)         echo "dev-browser <<< 'const p = await browser.getPage(\"bench\"); const s = await p.snapshotForAI(); console.log(s.full)'" ;;
    eval_simple)      echo "dev-browser <<< 'const p = await browser.getPage(\"bench\"); console.log(await p.evaluate(() => document.title))'" ;;
    eval_extract)     echo "dev-browser <<< 'const p = await browser.getPage(\"bench\"); console.log(await p.evaluate(() => JSON.stringify(Array.from(document.querySelectorAll(\"a\")).map(a=>a.href))))'" ;;
    tabs_list)        echo "dev-browser <<< 'console.log(JSON.stringify(await browser.listPages()))'" ;;
    form_fill)        echo "dev-browser <<< 'const p = await browser.getPage(\"bench\"); await p.goto(\"$FORM_URL\", {waitUntil:\"domcontentloaded\"}); console.log(await p.evaluate(() => { document.querySelector(\"#name\").value = \"Ada\"; document.querySelector(\"#email\").value = \"ada@example.com\"; document.querySelector(\"#city\").value = \"London\"; return [document.querySelector(\"#name\").value, document.querySelector(\"#email\").value, document.querySelector(\"#city\").value].join(\"|\"); }))'" ;;
    repeated_extract) echo "dev-browser <<< 'const p = await browser.getPage(\"bench\"); await p.goto(\"$COMPLEX_URL\", {waitUntil:\"domcontentloaded\"}); console.log(await p.evaluate(() => document.querySelectorAll(\"a\")[0]?.textContent)); console.log(await p.evaluate(() => document.querySelectorAll(\"a\")[1]?.textContent)); console.log(await p.evaluate(() => document.querySelectorAll(\"a\")[2]?.textContent)); console.log(await p.evaluate(() => document.querySelectorAll(\"a\")[3]?.textContent)); console.log(await p.evaluate(() => document.querySelectorAll(\"a\")[4]?.textContent));'" ;;
    batch_extract)    echo "dev-browser <<< 'const p = await browser.getPage(\"bench\"); await p.goto(\"$COMPLEX_URL\", {waitUntil:\"domcontentloaded\"}); console.log(await p.evaluate(() => JSON.stringify(Array.from(document.querySelectorAll(\"a\")).slice(0, 5).map((a) => a.textContent))));'" ;;
    error_path)       echo "dev-browser <<< 'const p = await browser.getPage(\"bench\"); console.log(await p.evaluate(() => document.querySelector(\"$MISSING_SELECTOR\").value));'" ;;
  esac
}

########################################################################
# Run benchmark sets
########################################################################

run_tool() {
  local short="$1" name="$2" ok="$3" factory="$4"
  [[ "$ok" -eq 0 ]] && return

  echo -e "  ${BOLD}${name}${NC}"
  for test in "${TESTS[@]}"; do
    local total=$((WARMUP + ITERATIONS))
    printf "    %-30s " "${LABELS[$test]}"
    local cmd
    cmd=$($factory "$test")
    for ((i = 1; i <= total; i++)); do
      time_cmd "${short}:${test}" "$cmd"
    done
    print_stat_line "$(calc_stats "$RESULTS_DIR/${short}:${test}.raw")"
  done
  echo ""
}

########################################################################
# Main benchmark
########################################################################

echo -e "${BOLD}Running warm-path benchmarks ...${NC}"
echo ""
run_tool "sg" "shuvgeist" "$SG_OK" "sg_cmd"
run_tool "ab" "agent-browser" "$AB_OK" "ab_cmd"
run_tool "db" "dev-browser" "$DB_OK" "db_cmd"

########################################################################
# Sidepanel-closed validation (shuvgeist)
########################################################################

echo -e "${BOLD}Running shuvgeist sidepanel-closed validation ...${NC}"
if [[ $SG_OK -eq 1 ]]; then
  printf "  %-30s " "Bridge works with sidepanel closed"
  result=$(validate_sg_closed_sidepanel)
  if [[ "$result" == "validated" ]]; then
    echo -e "${GREEN}PASS${NC} ${DIM}(extension connected, sidepanel-only caps absent, snapshot/eval succeed)${NC}"
  elif [[ "$result" == "sidepanel-open" ]]; then
    echo -e "${YELLOW}SKIP${NC} ${DIM}(sidepanel appears open; close it and re-run for strict validation)${NC}"
  else
    echo -e "${RED}FAIL${NC} ${DIM}(${result})${NC}"
  fi
  echo ""
fi

########################################################################
# Headless cold-start benchmark (shuvgeist only)
########################################################################

echo -e "${BOLD}Running shuvgeist headless cold-start benchmark ...${NC}"
if [[ $SG_OK -eq 1 ]]; then
  cold_ok=1
  for ((i = 1; i <= COLD_ITERATIONS; i++)); do
    shuvgeist close >/dev/null 2>&1 || true
    sleep 2
    if ! time_cmd_success_required "sg:cold_launch_headless" "shuvgeist launch --headless --url '$TEST_URL'"; then
      cold_ok=0
      break
    fi
    if ! time_cmd_success_required "sg:cold_launch_headless_plus_eval" "shuvgeist eval 'document.title'"; then
      cold_ok=0
      break
    fi
  done

  if [[ $cold_ok -eq 1 ]]; then
    printf "  %-30s " "Launch --headless"
    print_stat_line "$(calc_stats "$RESULTS_DIR/sg:cold_launch_headless.raw" 0)"
    printf "  %-30s " "Launch --headless + eval"
    print_stat_line "$(calc_stats "$RESULTS_DIR/sg:cold_launch_headless_plus_eval.raw" 0)"
  else
    echo -e "  ${RED}Headless cold-start benchmark failed.${NC}"
  fi
  echo ""
fi

########################################################################
# Comparison table
########################################################################

echo -e "${BOLD}=================================================================${NC}"
echo -e "${BOLD}  Head-to-Head Comparison (avg ms, lower is better)${NC}"
echo -e "${BOLD}=================================================================${NC}"
echo ""

declare -A MEANS
for test in "${TESTS[@]}"; do
  if [[ $SG_OK -eq 1 ]]; then read -r mean _ <<< "$(calc_stats "$RESULTS_DIR/sg:${test}.raw")"; MEANS["sg:${test}"]="$mean"; fi
  if [[ $AB_OK -eq 1 ]]; then read -r mean _ <<< "$(calc_stats "$RESULTS_DIR/ab:${test}.raw")"; MEANS["ab:${test}"]="$mean"; fi
  if [[ $DB_OK -eq 1 ]]; then read -r mean _ <<< "$(calc_stats "$RESULTS_DIR/db:${test}.raw")"; MEANS["db:${test}"]="$mean"; fi
done

printf "  ${BOLD}%-30s" "Test"
[[ $SG_OK -eq 1 ]] && printf "  %12s" "shuvgeist"
[[ $AB_OK -eq 1 ]] && printf "  %14s" "agent-browser"
[[ $DB_OK -eq 1 ]] && printf "  %14s" "dev-browser"
printf "${NC}\n"
printf "  %-30s" ""
[[ $SG_OK -eq 1 ]] && printf "  %12s" "------------"
[[ $AB_OK -eq 1 ]] && printf "  %14s" "--------------"
[[ $DB_OK -eq 1 ]] && printf "  %14s" "--------------"
printf "\n"

for test in "${TESTS[@]}"; do
  printf "  %-30s" "${LABELS[$test]}"
  fastest=999999999
  for ts in sg ab db; do
    val="${MEANS[${ts}:${test}]:-ERR}"
    [[ "$val" != "ERR" ]] && (( val < fastest )) && fastest=$val
  done

  for entry in "sg:$SG_OK:12" "ab:$AB_OK:14" "db:$DB_OK:14"; do
    IFS=: read -r ts ok width <<< "$entry"
    [[ "$ok" -eq 0 ]] && continue
    val="${MEANS[${ts}:${test}]:-ERR}"
    if [[ "$val" == "ERR" ]]; then
      printf "  ${RED}%${width}s${NC}" "FAIL"
    elif [[ "$val" -eq "$fastest" ]]; then
      printf "  ${GREEN}%$((width - 2))dms${NC}  " "$val"
    else
      ratio=""
      if (( fastest > 0 )); then
        r10=$(( val * 10 / fastest ))
        whole=$((r10 / 10))
        frac=$((r10 % 10))
        ratio=" ${whole}.${frac}x"
      fi
      printf "  ${YELLOW}%$((width - 6))dms${NC}%-6s" "$val" "$ratio"
    fi
  done
  printf "\n"
done

echo ""

########################################################################
# Save JSON results
########################################################################

json_file="$RESULTS_DIR/benchmark.json"
{
  echo '{'
  echo '  "metadata": {'
  echo "    \"timestamp\": \"$(date -Iseconds)\","
  echo "    \"warmup\": $WARMUP,"
  echo "    \"iterations\": $ITERATIONS,"
  echo "    \"cold_iterations\": $COLD_ITERATIONS,"
  echo "    \"test_url\": \"$TEST_URL\","
  echo "    \"complex_url\": \"$COMPLEX_URL\","
  echo '    "tools": {'
  echo "      \"shuvgeist\": { \"version\": \"${SG_VER:-N/A}\", \"available\": $([ $SG_OK -eq 1 ] && echo true || echo false) },"
  echo "      \"agent_browser\": { \"version\": \"${AB_VER:-N/A}\", \"available\": $([ $AB_OK -eq 1 ] && echo true || echo false) },"
  echo "      \"dev_browser\": { \"version\": \"${DB_VER:-N/A}\", \"available\": $([ $DB_OK -eq 1 ] && echo true || echo false) }"
  echo '    }'
  echo '  },'
  echo '  "results": {'
  first=1
  for test in "${TESTS[@]}"; do
    [[ $first -eq 0 ]] && echo ','
    first=0
    echo -n "    \"$test\": { \"label\": \"${LABELS[$test]}\""
    for ts in sg ab db; do
      file="$RESULTS_DIR/${ts}:${test}.raw"
      [[ ! -f "$file" ]] && continue
      read -r mean min max stddev n <<< "$(calc_stats "$file")"
      case "$ts" in sg) tname="shuvgeist";; ab) tname="agent_browser";; db) tname="dev_browser";; esac
      if [[ "$mean" == "ERR" ]]; then
        echo -n ", \"$tname\": null"
      else
        raw_vals=$(tail -n +"$((WARMUP + 1))" "$file" | tr '\n' ',' | sed 's/,$//')
        echo -n ", \"$tname\": { \"mean_ms\": $mean, \"min_ms\": $min, \"max_ms\": $max, \"stddev_ms\": $stddev, \"n\": $n, \"raw_ms\": [$raw_vals] }"
      fi
    done
    echo -n ' }'
  done
  if [[ -f "$RESULTS_DIR/sg:cold_launch_headless.raw" ]]; then
    echo ','
    read -r mean min max stddev n <<< "$(calc_stats "$RESULTS_DIR/sg:cold_launch_headless.raw" 0)"
    raw_vals=$(tr '\n' ',' < "$RESULTS_DIR/sg:cold_launch_headless.raw" | sed 's/,$//')
    echo -n "    \"cold_launch_headless\": { \"label\": \"Launch --headless\", \"shuvgeist\": { \"mean_ms\": $mean, \"min_ms\": $min, \"max_ms\": $max, \"stddev_ms\": $stddev, \"n\": $n, \"raw_ms\": [$raw_vals] } }"
    if [[ -f "$RESULTS_DIR/sg:cold_launch_headless_plus_eval.raw" ]]; then
      echo ','
      read -r mean min max stddev n <<< "$(calc_stats "$RESULTS_DIR/sg:cold_launch_headless_plus_eval.raw" 0)"
      raw_vals=$(tr '\n' ',' < "$RESULTS_DIR/sg:cold_launch_headless_plus_eval.raw" | sed 's/,$//')
      echo -n "    \"cold_launch_headless_plus_eval\": { \"label\": \"Launch --headless + eval\", \"shuvgeist\": { \"mean_ms\": $mean, \"min_ms\": $min, \"max_ms\": $max, \"stddev_ms\": $stddev, \"n\": $n, \"raw_ms\": [$raw_vals] } }"
    fi
  fi
  echo ''
  echo '  }'
  echo '}'
} > "$json_file"

echo -e "  Raw data: ${CYAN}${json_file}${NC}"
echo -e "  Status check: ${CYAN}$(validate_sg_closed_sidepanel 2>/dev/null || echo unavailable)${NC}"
echo ""
echo -e "${BOLD}Benchmark complete.${NC}"
echo ""
