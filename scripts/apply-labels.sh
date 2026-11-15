#!/usr/bin/env bash
# Terapkan label standar ke semua repo non-arsip di org.
# Pakai: ORG=Unitama-Sari-Mas ./scripts/apply-labels.sh   (butuh gh login dengan hak admin repo)
set -euo pipefail
ORG="${ORG:-Unitama-Sari-Mas}"

LABELS=(
  "bug|d73a4a|Ada yang rusak"
  "enhancement|1b4fa8|Fitur atau perbaikan baru"
  "security|b60205|Terkait keamanan"
  "infra|5319e7|Server, deploy, database"
  "docs|0075ca|Dokumentasi"
  "priority:high|e99695|Perlu segera"
  "priority:low|c2e0c6|Bisa menunggu"
  "blocked|000000|Menunggu hal lain"
  "good first task|7057ff|Cocok untuk anggota baru"
)

for repo in $(gh repo list "$ORG" --no-archived --json name -q '.[].name'); do
  echo "== $repo"
  for l in "${LABELS[@]}"; do
    IFS='|' read -r name color desc <<<"$l"
    gh label create "$name" --repo "$ORG/$repo" --color "$color" --description "$desc" --force >/dev/null
  done
done
