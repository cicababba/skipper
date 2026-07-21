#!/usr/bin/env bash
set -euo pipefail

# Sync an issue with the GitHub project board (user project cicababba/#4).
# Callers treat failures as non-fatal: board sync must never block the git flow.
#
# Usage:
#   board.sh add <issue>              # ensure the issue is on the board (Status untouched if already there)
#   board.sh status <issue> <status>  # ensure on board + set Status
#
# Status: Backlog | Todo | "In Progress" | Done
#
# IDs are pinned to the project; re-derive them if the board is recreated:
#   gh api graphql -f query='query{user(login:"cicababba"){projectV2(number:4){id field(name:"Status"){... on ProjectV2SingleSelectField{id options{id name}}}}}}'

err() { echo "ERROR: $*" >&2; exit 1; }

PROJECT_ID="PVT_kwHOArMbQ84BeCIF"
STATUS_FIELD_ID="PVTSSF_lAHOArMbQ84BeCIFzhYfTQE"

option_id() {
  case "$1" in
    Backlog) echo "8f9fff4b" ;;
    Todo) echo "f75ad846" ;;
    "In Progress") echo "47fc9ee4" ;;
    Done) echo "98236657" ;;
    *) err "unknown status '$1' (Backlog|Todo|In Progress|Done)" ;;
  esac
}

CMD="${1:-}"
ISSUE="${2:-}"
STATUS="${3:-}"

[[ "$CMD" == "add" || "$CMD" == "status" ]] || err "usage: board.sh add <issue> | board.sh status <issue> <status>"
[[ "$ISSUE" =~ ^[0-9]+$ ]] || err "not an issue number: $ISSUE"
[[ "$CMD" == "add" || -n "$STATUS" ]] || err "status command needs a status value"

CONTENT_ID=$(gh issue view "$ISSUE" --json id --jq '.id')

# addProjectV2ItemById is idempotent — returns the existing item if already on the board.
ITEM_ID=$(gh api graphql \
  -f query='mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}' \
  -f p="$PROJECT_ID" -f c="$CONTENT_ID" \
  --jq '.data.addProjectV2ItemById.item.id')

if [[ "$CMD" == "status" ]]; then
  OPT_ID=$(option_id "$STATUS")
  gh api graphql \
    -f query='mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}' \
    -f p="$PROJECT_ID" -f i="$ITEM_ID" -f f="$STATUS_FIELD_ID" -f o="$OPT_ID" >/dev/null
fi

echo "board_issue=$ISSUE"
echo "board_status=${STATUS:-unchanged}"
