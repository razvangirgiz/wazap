/**
 * `node --test` at a terminal exports FORCE_COLOR=1 to every test process, the
 * spawned CLIs inherit it, and their painted output stops matching the plain
 * strings the assertions read. Drop it before any test file loads, so the
 * children decide colour off their own piped stdio, the way every other run does.
 */
delete process.env.FORCE_COLOR;
