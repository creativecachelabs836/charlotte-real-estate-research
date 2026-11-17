"""Pull every Zillow property-search result out of the Claude session transcript
(inline results) and tool-results files (large results), tagged with the query
that produced them. Writes one JSON per query to an output dir."""
import json, re, sys, pathlib

transcript, outdir = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
outdir.mkdir(parents=True, exist_ok=True)
uses, results = {}, {}

for line in transcript.open():
    try: ev = json.loads(line)
    except Exception: continue
    msg = ev.get('message') or {}
    content = msg.get('content')
    if not isinstance(content, list): continue
    for c in content:
        if c.get('type') == 'tool_use' and c.get('name', '').endswith('zillow_property_search'):
            uses[c['id']] = c['input']
        elif c.get('type') == 'tool_result' and c.get('tool_use_id') in uses or c.get('type') == 'tool_result':
            body = c.get('content')
            if isinstance(body, list):
                body = ''.join(x.get('text', '') for x in body if isinstance(x, dict))
            if isinstance(body, str):
                results[c['tool_use_id']] = body

n = 0
for uid, req in uses.items():
    body = results.get(uid)
    if body is None: continue
    data = None
    if body.lstrip().startswith('{'):
        try: data = json.loads(body)
        except Exception: pass
    if data is None:
        m = re.search(r'saved to (\S+\.txt)', body)
        if m and pathlib.Path(m.group(1)).exists():
            data = json.loads(pathlib.Path(m.group(1)).read_text())
    if data is None or 'results' not in data: continue
    (outdir / f'{uid}.json').write_text(json.dumps({'request': req, **data}))
    n += 1
print(f'{n} search results extracted')
