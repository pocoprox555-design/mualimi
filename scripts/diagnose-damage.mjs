// Diagnostic: how much of the "damaged text" verdict is the single bidirectional
// `اال` artifact, and is repairing it deterministic and safe?
import { getIndex, assessText } from '../lib/index.mjs';

// The bidi artifact: an extra alif glued to the article, e.g. "االقتصاد" for
// "الاقتصاد". It only occurs at a word start after a delimiter.
const BOUNDARY = '(?:^|[\\s(\\u00AB"\\u201C،.:؛؟!\\u0640-])';
const AL_ARTIFACT = new RegExp(`${BOUNDARY}اال`, 'g');

async function main() {
  const index = await getIndex();
  const docs = index.documents.filter((doc) => doc.evidenceStatus === 'damaged-text');

  let fixedByArtifactOnly = 0;
  let artifactPlusOther = 0;
  let otherOnly = 0;
  const residual = [];

  for (const doc of docs) {
    const text = String(doc.text || '');
    const hadArtifact = new RegExp(`${BOUNDARY}اال`).test(text);
    const repaired = text.replace(AL_ARTIFACT, (m) => `${m[0] === '^' ? '' : m[0]}ال`);
    const verdict = assessText(repaired);
    if (!hadArtifact) {
      otherOnly += 1;
      if (residual.length < 8) residual.push({ id: doc.id, artifact: false, reasons: verdict.reasons.slice(0, 2), sample: text.slice(0, 140) });
    } else if (!verdict.damaged) {
      fixedByArtifactOnly += 1;
    } else {
      artifactPlusOther += 1;
      if (residual.length < 8) residual.push({ id: doc.id, artifact: true, reasons: verdict.reasons.slice(0, 2), sample: repaired.slice(0, 140) });
    }
  }

  console.log(`damaged pages: ${docs.length} of ${index.documents.length}`);
  console.log(`repaired by اال -> ال alone : ${fixedByArtifactOnly}`);
  console.log(`artifact + other damage     : ${artifactPlusOther}`);
  console.log(`damage unrelated to artifact: ${otherOnly}`);
  console.log('\nresidual samples:');
  for (const item of residual) console.log(` ${item.id} artifact=${item.artifact}\n   reasons: ${item.reasons.join(' ; ')}\n   ${item.sample.replace(/\n/g, ' ')}`);

  // How many pages would become quotable overall after this repair?
  const all = index.documents;
  let wouldBeReliable = 0;
  for (const doc of all) {
    const text = String(doc.text || '');
    const repaired = text.replace(AL_ARTIFACT, (m) => `${m[0] === '^' ? '' : m[0]}ال`);
    const verdict = assessText(repaired);
    if (!verdict.damaged && text.length >= 20) wouldBeReliable += 1;
  }
  console.log(`\npages with trustworthy text after repair: ${wouldBeReliable} of ${all.length}`);

  // Sanity: words that legitimately start with اال must not exist, otherwise the
  // repair would corrupt real content.
  const suspects = new Map();
  for (const doc of all) {
    for (const match of String(doc.text || '').matchAll(new RegExp(`${BOUNDARY}اال(\\S{0,12})`, 'g'))) {
      const word = `اال${match[1]}`.replace(/[^؀-ۿ]/g, '');
      suspects.set(word, (suspects.get(word) || 0) + 1);
    }
  }
  const top = [...suspects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log('\nmost common اال-words (repair candidates):');
  console.log(top.map(([word, count]) => `${word}=${count}`).join('  '));
}

main();