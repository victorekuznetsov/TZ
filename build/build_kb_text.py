#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Извлекает текст из документов базы знаний для полнотекстового поиска.

Поддержаны PDF (pypdf) и DOCX/PPTX (python-docx/python-pptx) — оба
надёжно работают без внешних зависимостей. Легаси .doc/.ppt (104 файла
в АТ-Майнинг) НЕ извлекаются: LibreOffice headless конвертация не
работает в этой песочнице («source file could not be loaded» даже на
заведомо исправном файле) — известный пробел, см. quality.json.

Каталоги PDF (сканы без текстового слоя) уже исключены на уровне
build_kb.py — сюда не попадают вовсе.

Текст на документ обрезается (по умолчанию 60 000 знаков — этого
хватает на первые ~30-40 страниц типового руководства) — иначе индекс
по 390-страничному тому раздувает файл без пользы для поиска.

Источник читается напрямую из git-объектов ветки rawdata (`git cat-file`)
— локальная копия 2,5 ГБ не требуется.

Выход: data/kb_text.json — {path: {text, chars, truncated}}

Запуск:
  python3 build/build_kb_text.py <repo_dir> <kb.json> <out_dir> [--limit N]
"""
import sys, os, json, subprocess, io, re, signal

MAX_CHARS = 60000
MAX_PAGES = 80  # страховка: не листать сотни страниц ради текста, если он редкий
DOC_TIMEOUT_SEC = 20  # pypdf иногда патологически виснет на одном повреждённом PDF


class TimeoutError_(Exception):
    pass


def _alarm(signum, frame):
    raise TimeoutError_()
SKIP_CLASSES = {"Чертежи CAD", "Фото", "Справочные таблицы"}
SUPPORTED_EXT = {".pdf", ".docx", ".pptx"}


def git_show(repo_dir, path):
    r = subprocess.run(["git", "-C", repo_dir, "cat-file", "-p", f"origin/rawdata:{path}"],
                        capture_output=True)
    if r.returncode != 0:
        return None
    return r.stdout


def extract_pdf(data):
    from pypdf import PdfReader
    r = PdfReader(io.BytesIO(data))
    out = []
    total = 0
    for i, page in enumerate(r.pages):
        if i >= MAX_PAGES:
            break
        t = page.extract_text() or ""
        out.append(t)
        total += len(t)
        if total > MAX_CHARS:
            break
    return "\n".join(out)


def extract_docx(data):
    import docx
    d = docx.Document(io.BytesIO(data))
    parts = [p.text for p in d.paragraphs]
    for t in d.tables:
        for row in t.rows:
            parts.append(" | ".join(c.text for c in row.cells))
    return "\n".join(parts)


def extract_pptx(data):
    from pptx import Presentation
    p = Presentation(io.BytesIO(data))
    parts = []
    for slide in p.slides:
        for shape in slide.shapes:
            if hasattr(shape, "text") and shape.text:
                parts.append(shape.text)
    return "\n".join(parts)


def clean(text):
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def main():
    args = sys.argv[1:]
    limit = None
    if "--limit" in args:
        i = args.index("--limit")
        limit = int(args[i + 1])
        args = args[:i] + args[i + 2:]
    repo_dir, kb_path, out_dir = args[:3]
    os.makedirs(out_dir, exist_ok=True)

    kb = json.load(open(kb_path, encoding="utf-8"))
    docs = [d for d in kb["docs"] if d["class"] not in SKIP_CLASSES
            and os.path.splitext(d["name"])[1].lower() in SUPPORTED_EXT]
    if limit:
        docs = docs[:limit]
    print(f"кандидатов на извлечение: {len(docs)}", file=sys.stderr)

    result = {}
    ok = fail = timedout = 0
    have_alarm = hasattr(signal, "SIGALRM")
    if have_alarm:
        signal.signal(signal.SIGALRM, _alarm)
    for n, d in enumerate(docs):
        ext = os.path.splitext(d["name"])[1].lower()
        data = git_show(repo_dir, d["path"])
        if data is None:
            fail += 1
            continue
        if have_alarm:
            signal.alarm(DOC_TIMEOUT_SEC)
        try:
            if ext == ".pdf":
                text = extract_pdf(data)
            elif ext == ".docx":
                text = extract_docx(data)
            elif ext == ".pptx":
                text = extract_pptx(data)
            else:
                continue
            text = clean(text)
            if not text:
                continue
            truncated = len(text) > MAX_CHARS
            result[d["path"]] = {"text": text[:MAX_CHARS], "chars": len(text), "truncated": truncated}
            ok += 1
        except TimeoutError_:
            timedout += 1
            print(f"  ТАЙМАУТ ({DOC_TIMEOUT_SEC}с): {d['path']}", file=sys.stderr)
        except Exception:
            fail += 1
        finally:
            if have_alarm:
                signal.alarm(0)
        if (n + 1) % 25 == 0:
            print(f"  {n+1}/{len(docs)}  ok={ok} fail={fail} timeout={timedout}", file=sys.stderr)

    out = {
        "meta": {
            "docsIndexed": ok, "docsFailed": fail, "docsTimedOut": timedout, "candidatesTotal": len(docs),
            "maxCharsPerDoc": MAX_CHARS,
            "note": ".doc/.ppt (легаси Office) не индексированы — LibreOffice headless "
                    "не работает в этой песочнице; см. quality.json",
        },
        "docs": result,
    }
    with open(os.path.join(out_dir, "kb_text.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"\nпроиндексировано: {ok}  не удалось: {fail}  таймаут: {timedout}  из {len(docs)}")


if __name__ == "__main__":
    main()
