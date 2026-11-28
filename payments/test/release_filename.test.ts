import { describe, expect, it } from "vitest";
import { releaseDownloadFilename, toCamelSegment } from "../src/release_filename";

describe("toCamelSegment", () => {
  it("turns a snake_case slug into CamelCase", () => {
    expect(toCamelSegment("sample_the_quiet_workshop")).toBe("SampleTheQuietWorkshop");
  });

  it("joins a display name with no separator", () => {
    expect(toCamelSegment("Jane Doe")).toBe("JaneDoe");
  });

  it("folds accents to ASCII", () => {
    expect(toCamelSegment("Zoë Ångström")).toBe("ZoeAngstrom");
  });

  it.each([
    ["Søren Kierkegaard", "SorenKierkegaard"],
    ["Straße", "Strasse"],
    ["Łukasz Żak", "LukaszZak"],
    ["Đorđe", "Dorde"],
    ["Ærø Œuvre", "AEroOEuvre"],
    ["Þórður", "Thordur"],
    ["Ħamid", "Hamid"],
  ])("transliterates letters NFKD cannot decompose: %s -> %s", (input, expected) => {
    expect(toCamelSegment(input)).toBe(expected);
  });

  it("returns an empty string when nothing alphanumeric remains", () => {
    expect(toCamelSegment("--- ..."))
      .toBe("");
  });
});

describe("releaseDownloadFilename", () => {
  const complete = {
    slug: "sample_the_quiet_workshop",
    creatorDisplayName: "ExpanPress",
    releaseYear: 2026,
  };

  it("builds <Publisher>_<ProductSlugCamel>_<CreatorName>_<Year>.pdf", () => {
    expect(releaseDownloadFilename("ExpanPress", complete)).toBe("ExpanPress_SampleTheQuietWorkshop_ExpanPress_2026.pdf");
  });

  it("uses the publisher it is given, not a literal", () => {
    expect(releaseDownloadFilename("Other Press", complete)).toBe("OtherPress_SampleTheQuietWorkshop_ExpanPress_2026.pdf");
  });

  it("builds the creator part from a FirstLast display name", () => {
    expect(releaseDownloadFilename("ExpanPress", { ...complete, creatorDisplayName: "jane doe" })).toBe(
      "ExpanPress_SampleTheQuietWorkshop_JaneDoe_2026.pdf",
    );
  });

  it("strips quotes and separators so the name is safe in a header", () => {
    const name = releaseDownloadFilename("ExpanPress", { ...complete, creatorDisplayName: 'Bad"Name\\' });
    expect(name).toBe("ExpanPress_SampleTheQuietWorkshop_BadName_2026.pdf");
    expect(name).toMatch(/^[A-Za-z0-9_.]+$/);
  });

  it.each([
    ["slug missing", { ...complete, slug: null }],
    ["slug empty", { ...complete, slug: "" }],
    ["creator missing", { ...complete, creatorDisplayName: undefined }],
    ["creator all punctuation", { ...complete, creatorDisplayName: "!!!" }],
    ["year missing", { ...complete, releaseYear: null }],
    ["year not an integer", { ...complete, releaseYear: 2026.5 }],
    ["year before 1900", { ...complete, releaseYear: 1899 }],
  ])("returns null when %s, so the caller logs the gap and serves under the storage key", (_label, parts) => {
    expect(releaseDownloadFilename("ExpanPress", parts)).toBeNull();
  });
});
