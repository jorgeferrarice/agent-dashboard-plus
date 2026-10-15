# shellcheck shell=bash
# Agent harness step of ./setup.sh: add-ons and skills installed
# into the AI agents (Claude Code, Codex, Grok) of this machine.
#
# Sourced by setup.sh, which provides run, say, info, warn, die,
# ask_yn, has, pkg_install, ensure_npm, PKG, OS and DRY_RUN.
#
# Selected items are installed or updated in the selected agent
# accounts. Items of this list that are installed but no longer
# selected are removed, after confirmation. Nothing outside this
# list is ever touched.
#
# Written for the bash 3.2 that ships with macOS.

# One line per item: id|source|TLDR. "addon" items have their
# own installers; the others come from `npx skills add <source>`.
harness_catalog() {
    cat <<'EOF'
caveman|addon|Terse replies; ultracave mode on in every session
rtk|addon|Condenses shell command output to save tokens
graphify|addon|Codebase knowledge graph the agent can query (/graphify .)
ponytail|addon|Lazy senior dev: YAGNI first and the shortest diff (full)
grill-with-docs|https://github.com/mattpocock/skills|Interview that sharpens a plan and writes ADRs and a glossary
tdd|https://github.com/mattpocock/skills|Test-driven development: red, green, refactor
handoff|https://github.com/mattpocock/skills|Compacts the conversation into a handoff doc for another agent
frontend-design|https://github.com/anthropics/skills|Distinctive intentional UI design instead of templated defaults
diagnosing-bugs|https://github.com/mattpocock/skills|Diagnosis loop for hard bugs and performance regressions
prototype|https://github.com/mattpocock/skills|Throwaway prototype to answer a design question
codebase-design|https://github.com/mattpocock/skills|Vocabulary for deep modules and clean interfaces
grilling|https://github.com/mattpocock/skills|Grills you about a plan until it holds up
code-review|https://github.com/mattpocock/skills|Reviews changes against standards and the spec
implement|https://github.com/mattpocock/skills|Implements a piece of work from a spec or tickets
wayfinder|https://github.com/mattpocock/skills|Maps work too big for one session into decision tickets
design-taste-frontend|https://github.com/leonxlnx/taste-skill|Anti-slop art direction for landing pages and sites
ui-taste|https://uizze.sh/|Better UI taste for web and iOS from Uizze playbooks
ios-design|https://uizze.sh/|iPhone UI that follows Apple's Human Interface Guidelines
wizard|https://github.com/mattpocock/skills|Bash wizard for setup steps only a human can do
EOF
}

HB_START="<!-- agent-dashboard-plus:skills start -->"
HB_END="<!-- agent-dashboard-plus:skills end -->"
HARNESS_HINT="## Skills

Before you start a task, check which skills you have (your skill
list, or this agent's skills folders). Use one whenever it fits the
task. When a skill the user did not ask for would help them, suggest
it in one line (its name and why) so they get the most out of their
setup."

# Notes collected while installing, printed at the end.
HARNESS_NOTES=""
note() { HARNESS_NOTES="$HARNESS_NOTES
    - $*"; }

source_of() { harness_catalog | awk -F'|' -v id="$1" '$1 == id {print $2}'; }
is_addon() { [[ "$(source_of "$1")" == addon ]]; }

# ── Selection ──────────────────────────────────────────────────

# Make sure gum (the arrow-key menu) is there; ask to install it.
ensure_gum() {
    has gum && return 0
    [[ $DRY_RUN == 1 ]] && return 1
    ask_yn "The selection menu needs gum (charm.sh). Install it?" y || return 1
    case "$PKG" in
    brew) pkg_install gum ;;
    apt)
        sudo mkdir -p /etc/apt/keyrings
        curl -fsSL https://repo.charm.sh/apt/gpg.key |
            sudo gpg --dearmor --yes -o /etc/apt/keyrings/charm.gpg
        echo "deb [signed-by=/etc/apt/keyrings/charm.gpg] https://repo.charm.sh/apt/ * *" |
            sudo tee /etc/apt/sources.list.d/charm.list >/dev/null
        pkg_install gum
        ;;
    dnf)
        printf '[charm]\nname=Charm\nbaseurl=https://repo.charm.sh/yum/\nenabled=1\ngpgcheck=1\ngpgkey=https://repo.charm.sh/yum/gpg.key\n' |
            sudo tee /etc/yum.repos.d/charm.repo >/dev/null
        pkg_install gum
        ;;
    *) return 1 ;;
    esac
    has gum
}

# Multi-select from stdin lines, all selected at first. Prints the
# chosen lines. Without a terminal or gum, every line is chosen.
choose_many() {
    local header="$1" lines
    lines="$(cat)"
    # gum takes the options on stdin and draws on the terminal
    # (stderr), so it works inside $(...).
    if [[ $DRY_RUN == 0 && -t 2 ]] && ensure_gum; then
        printf '%s\n' "$lines" |
            gum choose --no-limit --selected='*' --height 25 \
                --header "$header (space toggles, enter confirms)"
    else
        info "$header (all selected):"
        printf '%s\n' "$lines" | sed 's/^/      [x] /' >&2
        printf '%s\n' "$lines"
    fi
}

# Every agent account on this machine, one "agent dir" per line.
# The default account is listed when the CLI or its folder exists;
# extra accounts (~/.claude-work, ...) once they hold a login.
detect_accounts() {
    local agent def login d
    for agent in claude codex grok; do
        def="$HOME/.$agent"
        case "$agent" in
        claude) login=.claude.json ;;
        *) login=auth.json ;;
        esac
        if has "$agent" || [[ -d $def ]]; then
            echo "$agent $def"
        fi
        for d in "$def"-*; do
            [[ -d $d && -f $d/$login ]] && echo "$agent $d"
        done
    done
    return 0
}

# ── Per-account helpers ────────────────────────────────────────

default_dir() { echo "$HOME/.$1"; }

# Environment that points an agent's CLI at an account folder.
account_env() {
    local agent="$1" dir="$2"
    [[ $dir == "$(default_dir "$agent")" ]] && return
    case "$agent" in
    claude) echo "CLAUDE_CONFIG_DIR=$dir" ;;
    codex) echo "CODEX_HOME=$dir" ;;
    grok) echo "GROK_HOME=$dir" ;;
    esac
}

# Run a command for an account: run env [VAR=dir] cmd...
in_account() {
    local agent="$1" dir="$2" var
    shift 2
    var="$(account_env "$agent" "$dir")"
    if [[ -n $var ]]; then
        run env "$var" "$@"
    else
        run "$@"
    fi
}

# Where an agent account reads skills from.
skills_dir() {
    case "$1" in
    codex) echo "$HOME/.agents/skills" ;; # shared by every Codex account
    *) echo "$2/skills" ;;
    esac
}

# Global instruction file of an agent account.
instructions_file() {
    case "$1" in
    claude) echo "$2/CLAUDE.md" ;;
    *) echo "$2/AGENTS.md" ;;
    esac
}

# skills CLI agent id.
skills_agent() {
    case "$1" in
    claude) echo claude-code ;;
    *) echo "$1" ;;
    esac
}

# Whether an item is installed in an agent account.
is_installed() {
    local item="$1" agent="$2" dir="$3"
    case "$item:$agent" in
    caveman:claude | ponytail:claude)
        grep -qs "\"$item@$item\"" "$dir/plugins/installed_plugins.json"
        ;;
    ponytail:codex) grep -qs 'ponytail@ponytail' "$dir/config.toml" ;;
    ponytail:grok) [[ -d $dir/plugins/ponytail || -d $dir/installed-plugins/ponytail ]] ;;
    rtk:claude) grep -qs 'rtk hook claude' "$dir/settings.json" ;;
    rtk:codex) grep -qs 'rtk hook codex' "$dir/hooks.json" ;;
    rtk:grok | graphify:grok) return 1 ;;
    *) [[ -e "$(skills_dir "$agent" "$dir")/$item" ]] ;;
    esac
}

# Why an item cannot go into an agent; empty when it can.
unsupported() {
    case "$1:$2" in
    rtk:grok) echo "RTK has no Grok integration yet" ;;
    graphify:grok) echo "Graphify has no Grok platform" ;;
    esac
}

# ── Install and remove ─────────────────────────────────────────

install_addon() {
    local item="$1" agent="$2" dir="$3"
    case "$item:$agent" in
    caveman:claude | ponytail:claude)
        local repo=JuliusBrussee/caveman
        [[ $item == ponytail ]] && repo=DietrichGebert/ponytail
        in_account claude "$dir" claude plugin marketplace add "$repo" || true
        in_account claude "$dir" claude plugin install "$item@$item" ||
            in_account claude "$dir" claude plugin update "$item@$item"
        ;;
    caveman:codex | caveman:grok)
        in_account "$agent" "$dir" npx -y github:JuliusBrussee/caveman -- --only "$agent"
        if [[ $agent == grok ]]; then
            note "Caveman on Grok is experimental (skills only, per its authors)."
        else
            note "Codex: run /hooks once to trust the Caveman hook."
        fi
        ;;
    ponytail:codex)
        in_account codex "$dir" codex plugin marketplace add DietrichGebert/ponytail || true
        in_account codex "$dir" codex plugin add ponytail@ponytail
        note "Codex: run /hooks once to trust the Ponytail hooks."
        ;;
    ponytail:grok)
        in_account grok "$dir" grok plugin install https://github.com/DietrichGebert/ponytail --trust ||
            in_account grok "$dir" grok plugin update ponytail
        in_account grok "$dir" grok plugin enable ponytail
        ;;
    rtk:claude) in_account claude "$dir" rtk init -g --auto-patch ;;
    rtk:codex) in_account codex "$dir" rtk init -g --codex --auto-patch ;;
    graphify:claude | graphify:codex)
        # graphify writes to the default account; others get a link.
        if [[ $dir == "$(default_dir "$agent")" || $agent == codex ]]; then
            run graphify install --platform "$agent"
        else
            link_skill graphify "$agent" "$dir"
        fi
        if [[ $agent == codex ]]; then
            note "Codex: Graphify wants multi_agent = true under [features] in ~/.codex/config.toml."
        fi
        ;;
    esac
}

remove_addon() {
    local item="$1" agent="$2" dir="$3"
    case "$item:$agent" in
    caveman:claude | ponytail:claude) in_account claude "$dir" claude plugin uninstall "$item@$item" ;;
    caveman:codex | caveman:grok)
        in_account "$agent" "$dir" npx -y github:JuliusBrussee/caveman -- --only "$agent" --uninstall
        ;;
    ponytail:codex) in_account codex "$dir" codex plugin remove ponytail@ponytail ;;
    ponytail:grok) in_account grok "$dir" grok plugin uninstall ponytail ;;
    rtk:claude) in_account claude "$dir" rtk init -g --uninstall ;;
    rtk:codex) in_account codex "$dir" rtk init -g --codex --uninstall ;;
    graphify:*) run rm -rf "$(skills_dir "$agent" "$dir")/graphify" ;;
    esac
}

# Link a skill installed in the agent's default account into
# another account of the same agent.
link_skill() {
    local name="$1" agent="$2" dir="$3" src target
    src="$(skills_dir "$agent" "$(default_dir "$agent")")/$name"
    target="$(skills_dir "$agent" "$dir")"
    if [[ $DRY_RUN == 1 ]]; then
        info "[dry-run] link $src into $target"
        return
    fi
    [[ -e $src ]] || {
        warn "$name is missing from $src; not linked into $dir"
        return
    }
    mkdir -p "$target"
    ln -sfn "$(cd "$src" && pwd -P)" "$target/$name"
}

# Install one skill into the given "agent dir" accounts.
install_skill() {
    local name="$1" accounts="$2" src agents="" agent dir
    src="$(source_of "$name")"
    while read -r agent dir; do
        [[ -z $agent ]] && continue
        case " $agents " in *" -a $(skills_agent "$agent") "*) ;; *) agents="$agents -a $(skills_agent "$agent")" ;; esac
    done <<<"$accounts"
    # shellcheck disable=SC2086 # $agents holds several flags.
    run npx -y skills add "$src" --skill "$name" -g -y $agents
    while read -r agent dir; do
        [[ -z $agent || $agent == codex || $dir == "$(default_dir "$agent")" ]] && continue
        link_skill "$name" "$agent" "$dir"
    done <<<"$accounts"
}

remove_skill() {
    local name="$1" agent="$2" dir="$3"
    if [[ $agent != codex && $dir != "$(default_dir "$agent")" ]]; then
        run rm -f "$(skills_dir "$agent" "$dir")/$name"
    else
        run npx -y skills remove "$name" -g -y -a "$(skills_agent "$agent")"
    fi
}

# Write a key into a small JSON config file, keeping other keys.
json_set() {
    local file="$1" key="$2" value="$3"
    if [[ $DRY_RUN == 1 ]]; then
        info "[dry-run] set $key=$value in $file"
        return
    fi
    mkdir -p "$(dirname "$file")"
    uv run -q --no-project python -c '
import json, os, sys
path, key, value = sys.argv[1:]
data = {}
if os.path.exists(path):
    with open(path) as f:
        data = json.load(f)
data[key] = value
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
' "$file" "$key" "$value"
}

# Put the skills instruction block into a file, or take it out
# when $2 is empty. Text outside the markers is kept as is.
set_hint_block() {
    local file="$1" text="$2" tmp
    if [[ $DRY_RUN == 1 ]]; then
        if [[ -n $text ]]; then
            info "[dry-run] write skills instructions into $file"
        else
            info "[dry-run] remove skills instructions from $file (if there)"
        fi
        return
    fi
    [[ -z $text && ! -f $file ]] && return
    mkdir -p "$(dirname "$file")"
    touch "$file"
    tmp="$(mktemp)"
    awk -v s="$HB_START" -v e="$HB_END" \
        '$0 == s {skip = 1; next} $0 == e {skip = 0; next} !skip' "$file" >"$tmp"
    if [[ -n $text ]]; then
        [[ -s $tmp && -n "$(tail -n 1 "$tmp")" ]] && echo >>"$tmp"
        printf '%s\n%s\n%s\n' "$HB_START" "$text" "$HB_END" >>"$tmp"
    fi
    cat "$tmp" >"$file"
    rm -f "$tmp"
}

# ── Step ───────────────────────────────────────────────────────

harness_step() {
    say "Agent harness"
    local items accounts all_accounts menu chosen item agent dir
    local installs="" removals="" skipped=""

    ensure_npm || {
        warn "Node.js and npm are required for the harness; skipping it."
        return
    }

    menu="$(harness_catalog | awk -F'|' '{printf "%-22s %s\n", $1, $3}')"
    chosen="$(printf '%s\n' "$menu" | choose_many "Harness for your AI agents")"
    items="$(printf '%s\n' "$chosen" | awk 'NF {print $1}')"

    all_accounts="$(detect_accounts)"
    if [[ -z $all_accounts ]]; then
        info "No Claude Code, Codex or Grok found: install one, then run ./setup.sh --harness."
        return
    fi
    menu="$(printf '%s\n' "$all_accounts" | sed "s|$HOME|~|")"
    chosen="$(printf '%s\n' "$menu" | choose_many "Install into these agent accounts")"
    accounts="$(printf '%s\n' "$chosen" | awk 'NF' | sed "s|~|$HOME|")"

    # Plan: install selected items into selected accounts; remove
    # this list's items from wherever they are no longer selected.
    while read -r agent dir; do
        [[ -z $agent ]] && continue
        local picked=0
        grep -qxF "$agent $dir" <<<"$accounts" && picked=1
        while read -r item; do
            [[ -z $item ]] && continue
            local wanted=0
            [[ $picked == 1 ]] && grep -qxF "$item" <<<"$items" && wanted=1
            if [[ $wanted == 1 && -n "$(unsupported "$item" "$agent")" ]]; then
                skipped="$skipped
    - $item for $agent: $(unsupported "$item" "$agent")"
            elif [[ $wanted == 1 ]]; then
                installs="$installs
$item $agent $dir"
            elif is_installed "$item" "$agent" "$dir"; then
                removals="$removals
$item $agent $dir"
            fi
        done <<<"$(harness_catalog | cut -d'|' -f1)"
    done <<<"$all_accounts"

    if [[ -n $removals ]]; then
        info "No longer selected, installed by an earlier run or by hand:"
        printf '%s\n' "$removals" | awk 'NF {print "      " $1 " from " $3}' | sed "s|$HOME|~|"
        if ask_yn "Remove them?" n; then
            while read -r item agent dir; do
                [[ -z $item ]] && continue
                if is_addon "$item"; then
                    remove_addon "$item" "$agent" "$dir" </dev/null
                else
                    remove_skill "$item" "$agent" "$dir" </dev/null
                fi
            done <<<"$removals"
        fi
    fi

    # Tools the add-ons need, once.
    if grep -q '^rtk ' <<<"$installs" && ! has rtk; then
        if [[ $PKG == brew ]]; then
            pkg_install rtk
        else
            run sh -c 'curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh'
        fi
    fi
    if grep -q '^graphify ' <<<"$installs"; then
        run uv tool install --upgrade graphifyy
    fi

    # Add-ons per account; each skill in one go for all accounts.
    while read -r item; do
        [[ -z $item ]] && continue
        local targets
        targets="$(awk -v i="$item" '$1 == i {print $2, $3}' <<<"$installs")"
        [[ -z $targets ]] && continue
        info "installing $item"
        if is_addon "$item"; then
            while read -r agent dir; do
                install_addon "$item" "$agent" "$dir" </dev/null ||
                    warn "$item failed for $dir"
            done <<<"$targets"
        else
            install_skill "$item" "$targets" </dev/null || warn "$item failed"
        fi
    done <<<"$items"

    grep -q '^caveman ' <<<"$installs" &&
        json_set "$HOME/.config/caveman/config.json" defaultMode ultracave
    grep -q '^ponytail ' <<<"$installs" &&
        json_set "$HOME/.config/ponytail/config.json" defaultMode full

    # Skills instructions: in every selected account when anything
    # is selected, out of every other account.
    while read -r agent dir; do
        [[ -z $agent ]] && continue
        if [[ -n $items ]] && grep -qxF "$agent $dir" <<<"$accounts"; then
            set_hint_block "$(instructions_file "$agent" "$dir")" "$HARNESS_HINT"
        else
            set_hint_block "$(instructions_file "$agent" "$dir")" ""
        fi
    done <<<"$all_accounts"

    [[ -n $skipped ]] && info "Skipped (not supported):$skipped"
    [[ -n $HARNESS_NOTES ]] && info "To finish:$HARNESS_NOTES"
    return 0
}
