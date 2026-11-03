#!/usr/bin/env python3
"""
Creates the Korean Pronunciation Dictionary on ElevenLabs using add-from-rules.
Usage:
    python3 create-dictionary.py [API_KEY]
Or set ELEVENLABS_API_KEY environment variable.
"""

import sys
import os
import json
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET

def get_rules_from_pls(pls_path="pronunciation-dictionary.pls"):
    tree = ET.parse(pls_path)
    root = tree.getroot()
    ns = {"pls": "http://www.w3.org/2005/01/pronunciation-lexicon"}
    rules = []
    for lex in root.findall(".//pls:lexeme", ns):
        g = lex.find("pls:grapheme", ns)
        p = lex.find("pls:phoneme", ns)
        a = lex.find("pls:alias", ns)
        if g is not None and g.text:
            text = g.text.strip()
            if p is not None and p.text:
                phoneme = p.text.strip()
                rules.append({
                    "string_to_replace": text,
                    "type": "phoneme",
                    "phoneme": phoneme,
                    "alphabet": "ipa"
                })
            elif a is not None and a.text:
                alias = a.text.strip()
                rules.append({
                    "string_to_replace": text,
                    "type": "alias",
                    "alias": alias
                })
    return rules

def create_dictionary(api_key):
    rules = get_rules_from_pls()
    payload = {
        "name": "Korean Player Names",
        "description": "Custom pronunciations for Korean player names in Word-Tac-Toe",
        "rules": rules
    }

    url = "https://api.elevenlabs.io/v1/pronunciation-dictionaries/add-from-rules"
    headers = {
        "Content-Type": "application/json",
        "xi-api-key": api_key
    }

    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")

    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            print("\n🎉 Pronunciation Dictionary Created Successfully!")
            print(f"Dictionary Name: {data.get('name')}")
            print(f"Dictionary ID:   {data.get('id')}")
            print(f"Version ID:      {data.get('version_id')}")
            print(f"Rules Added:     {data.get('version_rules_num')}")
            return data
    except urllib.error.HTTPError as e:
        error_msg = e.read().decode("utf-8")
        print(f"\n❌ ElevenLabs API Error ({e.code}): {error_msg}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    key = sys.argv[1] if len(sys.argv) > 1 else os.getenv("ELEVENLABS_API_KEY")
    if not key:
        print("Usage: python3 create-dictionary.py <YOUR_ELEVENLABS_API_KEY>")
        print("Or set the ELEVENLABS_API_KEY environment variable.")
        sys.exit(1)
    create_dictionary(key)
