/** Check the real npm manifest, version agreement and public documentation boundary. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const json=name=>JSON.parse(readFileSync(join(root,name),'utf8'));
const pkg=json('package.json');
for(const name of ['npm-shrinkwrap.json','manifest.json','server.json','.claude-plugin/plugin.json','gemini-extension.json']) assert.equal(json(name).version,pkg.version,`${name} version`);
assert.equal(json('npm-shrinkwrap.json').packages[''].version,pkg.version);
assert.equal(json('server.json').packages[0].version,pkg.version);
for(const name of ['.claude-plugin/plugin.json','gemini-extension.json']) assert.ok(json(name).mcpServers.whatsapp.args.includes(`wazap-mcp@${pkg.version}`),`${name} pinned launcher`);
const publicDocs=pkg.files.filter(path=>path.startsWith('docs/'));
assert.ok(publicDocs.includes('docs/beta.md'));
assert.ok(!pkg.files.includes('docs'),'Ship explicit public documents, never the entire docs directory');
const npm=process.platform==='win32'?'npm.cmd':'npm';
const packed=JSON.parse(execFileSync(npm,['pack','--dry-run','--json'],{cwd:root,encoding:'utf8',shell:process.platform==='win32'}))[0];
const names=packed.files.map(f=>f.path);
for(const path of ['dist/index.js','AGENT.md','npm-shrinkwrap.json',...publicDocs]) assert.ok(names.includes(path),`Missing ${path}`);
const skills=readdirSync(join(root,'skills'),{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>`skills/${e.name}/SKILL.md`);
assert.equal(skills.length,5);for(const path of skills)assert.ok(names.includes(path),`Missing ${path}`);
for(const path of names){
 assert.ok(!path.startsWith('docs/')||publicDocs.includes(path),`Internal document leaked: ${path}`);
 assert.ok(!/(?:^|\/)(?:\.env|auth|oauth\.json|daemon\.json|archive\.sqlite)(?:$|\/)|-(?:verification|review|plan)\.md$/.test(path),`Private file leaked: ${path}`);
 if(/\.(?:js|json|md|yml)$/.test(path)) assert.doesNotMatch(readFileSync(join(root,path),'utf8'),/https:\/\/chatgpt\.com\/c\/[\w-]+|\/Users\/[^/\s]+\/(?:Documents|\.wazap)/,`Personal reference in ${path}`);
}
const docker=readFileSync(join(root,'Dockerfile'),'utf8');
assert.ok(!/^COPY docs \.\/docs/m.test(docker),'Docker must also select public docs');
for(const path of publicDocs)assert.ok(docker.includes(path),`Docker missing ${path}`);
const stage=process.argv[2];
if(stage){
 const shipped=readdirSync(join(stage,'docs')).map(name=>`docs/${name}`).sort();
 assert.deepEqual(shipped,[...publicDocs].sort(),'Bundle documentation differs from npm');
 for(const path of skills)assert.ok(existsSync(join(stage,path)));
}
console.log(`release ${pkg.version}: ${names.length} npm files, 5 workflows, public docs only, versions and launchers consistent`);
