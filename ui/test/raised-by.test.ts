import { describe, expect, it } from "vitest";
import { botPillClass, raisedByFromId, raisedByOf } from "../src/raisedBy";

describe("raisedByOf", () => {
  it("prefers raised_by, then agent, then the id prefix, and leaves the rest blank", () => {
    expect(raisedByOf({ id: "qa-2016-ci-rerun", raised_by: "Planner" })).toBe("Planner");
    expect(raisedByOf({ id: "other", agent: "QA" })).toBe("QA");
    expect(raisedByFromId("planner-hello")).toBe("Planner");
    expect(raisedByFromId("decision:qa-2016-ci-rerun")).toBe("QA");
    expect(raisedByFromId("engineer-dev-merge-go-live")).toBe("Engineer");
    expect(raisedByFromId("eggbot-scheduled-merge-push")).toBe("dr eggbot");
    expect(raisedByFromId("grok-bot-status")).toBe("Grok Bot");
    expect(raisedByOf({ id: "rows-5844-duplicate-role" })).toBeUndefined();
    expect(raisedByOf({ id: "qa-2016-ci-rerun", bot: "Engineer" })).toBe("QA");
  });

  it("gives each bot its own pill class", () => {
    expect(botPillClass("Planner")).toBe("bot-pill bot-pill-planner");
    expect(botPillClass("QA")).toBe("bot-pill bot-pill-qa");
    expect(botPillClass("Engineer")).toBe("bot-pill bot-pill-engineer");
    expect(botPillClass("dr eggbot")).toBe("bot-pill bot-pill-eggbot");
    expect(botPillClass("Grok Bot")).toBe("bot-pill bot-pill-grok");
    const classes = ["Planner", "QA", "Engineer", "dr eggbot", "Grok Bot"].map(botPillClass);
    expect(new Set(classes).size).toBe(5);
  });
});
