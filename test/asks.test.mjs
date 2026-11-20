/**
 * The words that make a message an ask, shared by catch_up's `waiting` and
 * get_unanswered: what asks the user, and what only sounds like it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { closesAsk, readsAsAsk, wordsAsk } from "../dist/asks.js";

test("automated delivery and verification notices are not personal asks", () => {
  for (const words of [
    "Coletul cu AWB 123456789 ajunge azi. PIN 4321. https://curier.ro/track Ți-ai schimbat planurile?",
    "Your delivery tracking 123456789 is ready. Change plans? https://courier.test",
    "Your verification code is 123456. Did you request this?",
    "Codul de autentificare este 123456. Nu l-ai cerut?",
    "123456 is your verification code. Didn't request this?",
    "123456 este codul tău de verificare. Nu l-ai cerut?",
  ]) assert.equal(wordsAsk(words), false, words);
  for (const words of ["Poți ridica un colet pentru mine?", "Can you send me the tracking number?", "Can we meet at 1234 Main Street?", "Can you pin the 2026 holiday schedule?", ""]) {
    assert.equal(wordsAsk(words), words !== "", words);
  }
});

test("closing and deferral statements close asks without swallowing a new request", () => {
  for (const words of ["Cand o sa am ocazia, te contactez sa probam.", "Ok, când o să am ocazia, te contactez", "Bine, când o să am ocazia, te contactez", "Sigur, când o să am ocazia, te contactez", "I'll get back to you when I can.", "Nu mai e nevoie, mulțumesc."]) {
    assert.equal(closesAsk(words), true, words);
  }
  for (const words of ["", "Mulțumesc", "I'll get back to you. Can you send me the file?", "I'll get back to you. When do you arrive", "Ok, când o să am ocazia, te contactez. Când ajungi", "te anunț, dar trimite factura"]) {
    assert.equal(closesAsk(words), false, words);
  }
});

test("a question word asks when it opens a sentence, after at most a connective, and not inside a statement", () => {
  for (const words of ["când ajungi", "Cand vii", "Ok, când vii", "am ajuns. unde esti", "Cât costă", "and where are you", "when do you land"]) {
    assert.equal(wordsAsk(words), true, words);
  }
  for (const words of ["I’m not sure when I will get it.", "nu știu când ajung", "e cât se poate de bine", "îți zic unde stăm după"]) {
    assert.equal(wordsAsk(words), false, words);
  }
});

test("request words ask wherever they stand, diacritics or not, and a verdict or a refusal does not", () => {
  for (const words of ["sună-mă", "Sună-l pe Dan", "suna-ma diseara", "te rog frumos să iei legătura", "poți să-mi trimiți contractul", "confirmă", "I need the invoice"]) {
    assert.equal(wordsAsk(words), true, words);
  }
  for (const words of ["Sună bine", "suna ok", "I don’t need it anymore", "no need", "Mulțumesc, am primit"]) {
    assert.equal(wordsAsk(words), false, words);
  }
});

test("a question mark asks, one inside a link does not, and a voice note asks by its transcript", () => {
  assert.equal(wordsAsk("ai timp mâine?"), true);
  assert.equal(wordsAsk("https://example.ro/?a=1"), false);
  assert.equal(readsAsAsk({ type: "voice", text: "[voice · 0:10]", transcript: "când vii acasă" }), true);
  assert.equal(readsAsAsk({ type: "voice", text: "[voice · 0:10]", transcript: null }), true, "unheard is an ask until proven otherwise");
  assert.equal(readsAsAsk({ type: "call", text: "[voice call]", transcript: null }), false);
});
