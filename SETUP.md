# Cara pasang (±10 menit)

Semua isi folder ini ditaruh di repo **`.github`** milik org `Unitama-Sari-Mas` (publik).

1. Buat repo `Unitama-Sari-Mas/.github` (publik) dan push seluruh isi folder ini ke branch `main`.
   - `profile/README.md` otomatis menjadi halaman depan org.
   - `ISSUE_TEMPLATE/`, `PULL_REQUEST_TEMPLATE.md`, `CONTRIBUTING.md`, `SECURITY.md` otomatis menjadi default semua repo yang belum punya sendiri.
2. **Token monitoring** (agar semua repo terbaca): buat token read-only (fine-grained PAT: akses ke semua repo org, izin Metadata, Contents, Issues, Pull requests, Actions/Commit statuses: Read). Simpan sebagai secret repo `.github` bernama `ORG_MONITOR_TOKEN`. Tanpa ini, `GITHUB_TOKEN` bawaan hanya cukup untuk repo publik.
3. Settings → Actions → General → izinkan workflow *Read and write permissions*.
4. Tab Actions → **Monitor repo organisasi** → *Run workflow* sekali. Setelah itu berjalan tiap 6 jam.
5. **Dashboard**: Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/docs`. Alamat: `https://unitama-sari-mas.github.io/.github/`.
6. (Opsional) Seragamkan label: `./scripts/apply-labels.sh`.
7. Salin `templates/README.repo.md` ke tiap repo, ganti `NAMA_REPO`.

## Catatan
- Dashboard dan tabel README **publik**. Secara default hanya repo publik yang dimasukkan (`INCLUDE_PRIVATE: 'false'`). Jangan ubah ke `true` jika Pages/README terlihat publik, karena nama repo privat akan bocor.
- Ganti teks bertanda ✏️ di `profile/README.md` dengan deskripsi dan daftar area yang sesuai.
- Pratinjau dashboard dengan data contoh: buka `docs/index.html` lewat server lokal dengan `?demo` (mis. `python3 -m http.server -d docs`).
