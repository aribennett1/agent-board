// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown, RichText, hasFence, inline } from "../src/markdown";

const PHP = `\`\`\`php
$code = DeductionPayCode::query()->lockForUpdate()->findOrFail($id);
if (($validated['amount'] ?? $code->amount) === null) {
    throw ValidationException::withMessages(['amount' => 'An amount is required for this deduction code.']);
}
\`\`\``;

describe("hasFence", () => {
  it("detects fenced blocks and ignores inline backticks", () => {
    expect(hasFence(PHP)).toBe(true);
    expect(hasFence("See `Foo::bar()` for the check.")).toBe(false);
    expect(hasFence("Intro\n```sql\nSELECT 1;\n```")).toBe(true);
  });
});

describe("Markdown fenced code", () => {
  it("renders a php fence as a pre/code block with Dark+ highlighting", () => {
    const { container } = render(<Markdown text={PHP} />);
    const pre = container.querySelector("pre.md-code");
    expect(pre).not.toBeNull();
    expect(pre!.getAttribute("data-lang")).toBe("php");
    expect(pre!.querySelector(".md-code-lang")!.textContent).toBe("php");
    const code = pre!.querySelector("code.language-php")!;
    expect(code.textContent).toContain("DeductionPayCode::query()->lockForUpdate()");
    expect(code.textContent).toContain("ValidationException::withMessages");
    expect(code.querySelector(".hljs-variable")!.textContent).toBe("$code");
    expect(code.querySelector(".hljs-keyword")).not.toBeNull();
    expect(container.querySelector("p")).toBeNull();
  });

  it("keeps a fence nested in a list item as a code block, not flattened inline code", () => {
    const text = `- After the locked re-read, run the same required checks.\n  \`\`\`php\n  $code = DeductionPayCode::query()->lockForUpdate()->findOrFail($id);\n  \`\`\``;
    const { container } = render(<Markdown text={text} />);
    const li = container.querySelector("li")!;
    expect(li.querySelector("pre.md-code")).not.toBeNull();
    expect(li.querySelector("pre.md-code")!.textContent).toContain("lockForUpdate");
    expect(li.textContent).not.toMatch(/^php\s+\$code/);
    // The language tag is a label, not a flattened "php $code = ..." prefix.
    expect(li.querySelector("code")!.textContent!.trim().startsWith("$code")).toBe(true);
  });

  it("treats a list item that is itself a fence as a code block", () => {
    const text = `- \`\`\`php\n$code = DeductionPayCode::query()->lockForUpdate()->findOrFail($id);\n\`\`\``;
    const { container } = render(<Markdown text={text} />);
    expect(container.querySelector("li pre.md-code code")!.textContent).toContain("lockForUpdate");
    expect(container.querySelector("li pre.md-code")!.getAttribute("data-lang")).toBe("php");
  });

  it("escapes tags in code so they render as text, not elements", () => {
    const text = "```js\nconst x = \"<script>alert(1)</script>\";\n```";
    const { container } = render(<Markdown text={text} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("pre.md-code")!.textContent).toContain("<script>alert(1)</script>");
  });

  it("leaves an unknown language unhighlighted, still in a code block", () => {
    const { container } = render(<Markdown text={"```xyz\nfoo bar\n```"} />);
    const code = container.querySelector("pre.md-code code")!;
    expect(code.textContent).toBe("foo bar");
    expect(code.querySelector("span")).toBeNull();
  });

  it("renders inline code as a monospace code element, not a pre block", () => {
    const { container } = render(<Markdown text={"Use `lockForUpdate()` on the row."} />);
    expect(container.querySelector("pre")).toBeNull();
    const code = container.querySelector("p code")!;
    expect(code.textContent).toBe("lockForUpdate()");
  });
});

describe("RichText", () => {
  it("uses a code block for a fenced details item and inline for a plain sentence", () => {
    const fenced = render(<RichText text={PHP} k="a" />);
    expect(fenced.container.querySelector("pre.md-code")).not.toBeNull();
    expect(fenced.container.querySelector("pre.md-code code")!.textContent).toContain("lockForUpdate");
    const plain = render(<RichText text="A lock only lasts for the length of a database transaction." k="b" />);
    expect(plain.container.querySelector("pre")).toBeNull();
    expect(plain.container.textContent).toBe("A lock only lasts for the length of a database transaction.");
    expect(inline("just text", "x").join("")).toBe("just text");
  });
});

describe("unfenced code detection", () => {
  it("renders an unfenced PHP bullet as a highlighted block", () => {
    const text = `- $code = DeductionPayCode::query()->lockForUpdate()->findOrFail($id);`;
    const { container } = render(<RichText text={text} k="php-bullet" />);
    const pre = container.querySelector("pre.md-code");
    expect(pre).not.toBeNull();
    expect(pre!.querySelector("code")!.textContent).toContain("DeductionPayCode::query()->lockForUpdate()");
    expect(pre!.querySelector(".hljs-variable")!.textContent).toBe("$code");
    expect(container.textContent).not.toMatch(/^php\s+\$code/);
  });

  it("renders a bare multi-line dump as a highlighted block", () => {
    const dump = `$code = DeductionPayCode::query()->lockForUpdate()->findOrFail($id);
if (($validated['amount'] ?? $code->amount) === null) {
    throw ValidationException::withMessages(['amount' => 'An amount is required for this deduction code.']);
}`;
    const { container } = render(<RichText text={dump} k="dump" />);
    const pre = container.querySelector("pre.md-code");
    expect(pre).not.toBeNull();
    expect(pre!.querySelector("code")!.textContent).toContain("ValidationException::withMessages");
    expect(pre!.querySelector(".hljs-variable")).not.toBeNull();
    expect(pre!.querySelector(".hljs-keyword")).not.toBeNull();
  });

  it("leaves ticket links, times, and arrows as prose", () => {
    const text = "See [#1838](https://linear.app/rows/issue/1838) at 9:00 am → the next step, then go on.";
    const { container } = render(<RichText text={text} k="prose" />);
    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).toContain("9:00 am");
    expect(container.textContent).toContain("→");
  });

  it("leaves a sentence that only mentions a Class::method as prose", () => {
    const text = "See Foo::bar() for the check after the earlier copy.";
    const { container } = render(<Markdown text={text} />);
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector("p")!.textContent).toBe("See Foo::bar() for the check after the earlier copy.");
  });
});
