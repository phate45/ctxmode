# Café Notes — Ünïcödé Handling

The naïve tokenizer split « résumé » incorrectly; the fix normalizes to NFC first.

## Multilingual Labels

日本語のラベル and Ελληνικά labels round-trip through the exporter unchanged. Emoji status markers: ✅ done, ⚠️ blocked, 🚀 shipped.

## Währung

Amounts in € and ¥ keep their symbols; the formatter never rewrites them.
