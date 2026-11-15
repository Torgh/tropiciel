import { describe, expect, it } from "vitest";
import { blockedLink, decodeHeader, parseEmail } from "./email";

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

// Shaped like a LinkedIn job alert saved from Gmail: multipart/alternative, base64 HTML, QP plain text.
const ALERT = [
  "From: LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>",
  "To: ktos@example.com",
  "Subject: =?UTF-8?B?" + b64("„Java Developer”: 3 nowe oferty") + "?=",
  "Date: Fri, 13 Nov 2026 07:12:00 +0100",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="b1"',
  "",
  "--b1",
  "Content-Type: text/plain; charset=UTF-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Java Developer =E2=80=93 Acme, Wroc=C5=82aw",
  "https://www.linkedin.com/comm/jobs/view/4487911915/?trackingId=3Dabc&refId=3Dx",
  "",
  "--b1",
  "Content-Type: text/html; charset=UTF-8",
  "Content-Transfer-Encoding: base64",
  "",
  b64(
    '<p><a href="https://www.linkedin.com/comm/jobs/view/4487911915/?trackingId=abc">Java Developer</a> Acme · Wrocław</p>' +
      '<p><a href="https://www.olx.pl/oferta/praca/magazynier-CID4-ID1xyz.html?utm_source=mail">Magazynier</a></p>' +
      '<p><a href="https://www.linkedin.com/comm/psettings/email-unsubscribe?x=1">Wypisz się</a></p>',
  ),
  "--b1--",
  "",
].join("\r\n");

describe("saved e-mails (.eml)", () => {
  it("reads headers, text and the offers' links from a job alert", () => {
    const m = parseEmail(Buffer.from(ALERT, "latin1"));
    expect(m.from).toBe("LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>");
    expect(m.subject).toBe("„Java Developer”: 3 nowe oferty");
    expect(m.date).toBe("2026-11-13T06:12:00.000Z");
    expect(m.text).toContain("Java Developer – Acme, Wrocław");
    expect(m.linkedInJobs).toEqual(["https://www.linkedin.com/jobs/view/4487911915"]);
    expect(m.links).toEqual([
      { url: "https://www.linkedin.com/jobs/view/4487911915", label: "Java Developer" },
      { url: "https://www.olx.pl/oferta/praca/magazynier-CID4-ID1xyz.html", label: "Magazynier" },
    ]);
    expect(blockedLink(m.links[1].url)).toBe(true);
    expect(blockedLink(m.links[0].url)).toBe(false);
  });

  it("decodes Q-encoded headers and non-UTF-8 bodies, and falls back to the HTML text", () => {
    expect(decodeHeader("=?iso-8859-2?Q?Zaproszenie_na_rozmow=EA?=")).toBe("Zaproszenie na rozmowę");
    const raw = [
      "From: hr@firma.pl",
      "Subject: Rozmowa",
      "Content-Type: text/html; charset=iso-8859-2",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "<p>Dzie=F1 dobry,</p><p>zapraszamy na rozmow=EA.</p>",
    ].join("\n");
    expect(parseEmail(raw).text).toBe("Dzień dobry,\nzapraszamy na rozmowę.");
  });

  it("refuses files that are not e-mails", () => {
    expect(() => parseEmail("%PDF-1.7 binary")).toThrow(/\.eml/);
  });
});
