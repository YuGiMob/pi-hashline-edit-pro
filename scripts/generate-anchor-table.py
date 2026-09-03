import hashlib
import itertools
import json
import re
import sys

import tiktoken
from tokenizers import Tokenizer as HFTokenizer

ALNUM_TWO = re.compile(r"^[A-Za-z0-9]{2}$")
LLAMA_REPO = "hf-internal-testing/llama-tokenizer"
MISTRAL_REPO = "mistralai/Mistral-7B-v0.1"
EXPECTED_ANCHORS = 257795
EXPECTED_PIECES = 550


def tiktoken_pairs(name: str) -> set[str]:
    enc = tiktoken.get_encoding(name)
    pairs = set()
    for i in range(enc.n_vocab):
        try:
            s = enc.decode([i])
        except Exception:
            continue
        if ALNUM_TWO.match(s):
            pairs.add(s)
    return pairs


def hf_pair_sets(repo: str) -> tuple[set[str], set[str]]:
    vocab = set(HFTokenizer.from_pretrained(repo).get_vocab())
    mid = {t for t in vocab if ALNUM_TWO.match(t)}
    linestart = {t[1:] for t in vocab if t.startswith("▁") and ALNUM_TWO.match(t[1:])}
    return mid, linestart


def ntok(enc, s: str) -> int:
    if isinstance(enc, tiktoken.Encoding):
        return len(enc.encode(s))
    return len(enc.encode(s, add_special_tokens=False).ids)


def main() -> None:
    out_path = sys.argv[1] if len(sys.argv) > 1 else "src/hashline/anchor-table.json"
    o200k, cl100k, gpt2 = (tiktoken_pairs(n) for n in ["o200k_base", "cl100k_base", "gpt2"])
    llama_mid, llama_ls = hf_pair_sets(LLAMA_REPO)
    mistral_mid, mistral_ls = hf_pair_sets(MISTRAL_REPO)

    pieces = sorted(o200k & cl100k & gpt2 & llama_mid & mistral_mid & llama_ls & mistral_ls)
    assert len(pieces) == EXPECTED_PIECES, f"piece intersection drifted: {len(pieces)}"

    encs = [
        tiktoken.get_encoding("o200k_base"),
        tiktoken.get_encoding("cl100k_base"),
        tiktoken.get_encoding("gpt2"),
        HFTokenizer.from_pretrained(LLAMA_REPO),
        HFTokenizer.from_pretrained(MISTRAL_REPO),
    ]
    anchors = []
    for a, b in itertools.product(pieces, pieces):
        anc = a + b
        if max(ntok(enc, anc) for enc in encs) == 2:
            anchors.append(anc)
    anchors.sort()
    assert len(anchors) == EXPECTED_ANCHORS, f"anchor count drifted: {len(anchors)}"

    digest = hashlib.sha256("".join(anchors).encode()).hexdigest()[:16]
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"anchors": "".join(anchors)}, f, separators=(",", ":"))
    print(f"pieces={len(pieces)} anchors={len(anchors)} sha256[:16]={digest} -> {out_path}")


if __name__ == "__main__":
    main()
