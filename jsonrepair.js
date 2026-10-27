// Parses model output; recovers whatever was complete if the reply was cut off.
export function parseJson(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  if (start === -1) throw new Error("The review came back empty.");
  const body = clean.slice(start);
  const end = body.lastIndexOf("}");
  try {
    if (end === -1) throw new Error("incomplete");
    return JSON.parse(body.slice(0, end + 1));
  } catch (e) {
    return { ...repairJson(body), _partial: true };
  }
}

// If the reply was cut off mid-way, keep everything that was complete and close the rest.
function repairJson(body) {
  let inStr = false;
  let esc = false;
  const stack = [];
  let safe = -1;
  let safeStack = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      stack.pop();
      safe = i;
      safeStack = stack.slice();
    }
  }
  if (safe === -1) throw new Error("The review was cut off before any result was complete.");
  const closers = safeStack.reverse().map((c) => (c === "{" ? "}" : "]")).join("");
  const text = body.slice(0, safe + 1).replace(/,\s*$/, "") + closers;
  const obj = JSON.parse(text);
  if (!obj.verdict) throw new Error("The review was cut off before reaching a verdict.");
  return obj;
}

