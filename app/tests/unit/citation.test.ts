/**
 * The citation sentence: one paragraph per message that a newsroom can quote.
 *
 * Table-driven over verdict × caveat × key origin, and every row pins the WHOLE sentence. That is
 * the point: this test is where the wording is fixed, so a change to it is a visible diff and
 * never an accident. Hand-built findings, synthetic domains only.
 */

import { describe, expect, it } from '@gjsify/unit';
import {
    type Caveat,
    citationFor,
    type CitationOptions,
    type KeySource,
    type MessageFinding,
    type SignatureEvidence,
    type SignatureFinding,
    type UnverifiableReason,
    type Verdict,
} from '@stamped/core';

interface Shape {
    verdict: Verdict;
    caveats?: Caveat[];
    keySource?: KeySource;
    authorDomain?: string;
    artefact?: SignatureEvidence['exportArtefact'];
    reason?: UnverifiableReason;
}

function finding(shape: Shape): MessageFinding {
    if (shape.verdict === 'unsigned') return { verdict: 'unsigned', caveats: [], signatures: [] };
    const evidence = {
        domain: 'example.com',
        selector: 's1',
        algorithm: 'rsa-sha256',
        aligned: true,
        signedHeaders: [],
        ...(shape.keySource !== undefined ? { keySource: shape.keySource } : {}),
        ...(shape.authorDomain !== undefined ? { authorDomain: shape.authorDomain } : {}),
        ...(shape.artefact !== undefined ? { exportArtefact: shape.artefact } : {}),
        ...(shape.reason !== undefined ? { unverifiableBecause: shape.reason } : {}),
    } as unknown as SignatureEvidence;
    const basis: SignatureFinding = { verdict: shape.verdict, caveats: shape.caveats ?? [], evidence };
    return { verdict: shape.verdict, caveats: basis.caveats, basis, signatures: [basis] };
}

const UNCHANGED = 'The signed headers and body are unchanged since signing.';
const LIMITS = 'What the signature covers is unchanged since signing, with the following limits.';
const NOT_ALONE = 'That alone does not show manipulation.';
const NOTHING = 'This is not evidence of tampering; it only means no verdict is possible.';
const ANCHOR =
    'The receiving server recorded dkim=pass for this signature at delivery. That line is not signed: it is a claim of the archive and an indication, not proof.';

interface Row {
    name: string;
    shape: Shape;
    options?: CitationOptions;
    sentence: string;
}

const ROWS: Row[] = [
    {
        name: 'unsigned',
        shape: { verdict: 'unsigned' },
        sentence: 'The message carries no DKIM signature. That says nothing about it either way.',
    },
    {
        name: 'confirmed, key from the DNS',
        shape: { verdict: 'confirmed', keySource: 'dns' },
        sentence: `The message carries a valid DKIM signature of example.com, checked against a key published in the public DNS. ${UNCHANGED}`,
    },
    {
        name: 'confirmed, key from the examiner',
        shape: { verdict: 'confirmed', keySource: 'operator' },
        sentence: `The message carries a valid DKIM signature of example.com, checked against a key supplied by the examiner. ${UNCHANGED}`,
    },
    {
        name: 'confirmed, key of unknown origin',
        shape: { verdict: 'confirmed' },
        sentence: `The message carries a valid DKIM signature of example.com. ${UNCHANGED}`,
    },
    {
        name: 'confirmed, with the date',
        shape: { verdict: 'confirmed', keySource: 'dns' },
        options: { verifiedOn: '2026-11-11' },
        sentence: `The message carries a valid DKIM signature of example.com, checked against a key published in the public DNS. ${UNCHANGED} Checked on 2026-11-11.`,
    },
    {
        name: 'confirmed, an anchor adds nothing',
        shape: { verdict: 'confirmed', keySource: 'dns' },
        options: { receiverPass: true },
        sentence: `The message carries a valid DKIM signature of example.com, checked against a key published in the public DNS. ${UNCHANGED}`,
    },
    {
        name: 'archive key',
        shape: { verdict: 'confirmed-with-caveats', keySource: 'archive', caveats: ['archive-key'] },
        sentence: `The message carries a valid DKIM signature of example.com, checked against a key found in the archive itself. ${LIMITS} The public key came from the archive itself, so it proves consistency rather than authenticity.`,
    },
    {
        name: 'signer is not the author',
        shape: {
            verdict: 'confirmed-with-caveats',
            keySource: 'dns',
            caveats: ['signer-not-author'],
            authorDomain: 'corp.example.org',
        },
        sentence: `The message carries a valid DKIM signature of example.com, checked against a key published in the public DNS. ${LIMITS} The signature is from example.com, but the message claims to be from corp.example.org. It proves only that example.com handled the message, not that corp.example.org sent it.`,
    },
    {
        name: 'self-signed inside the perimeter',
        shape: {
            verdict: 'confirmed-with-caveats',
            keySource: 'operator',
            caveats: ['self-signed-perimeter'],
        },
        sentence: `The message carries a valid DKIM signature of example.com, checked against a key supplied by the examiner. ${LIMITS} The signing key was operated by the examined domain itself; a compromise of that infrastructure would have allowed signing arbitrary mail.`,
    },
    {
        name: 'two caveats, in the order they were found',
        shape: {
            verdict: 'confirmed-with-caveats',
            keySource: 'dns',
            caveats: ['rsa-sha1', 'unsigned-subject'],
        },
        sentence: `The message carries a valid DKIM signature of example.com, checked against a key published in the public DNS. ${LIMITS} Signed with rsa-sha1. SHA-1 collisions are practical, so a crafted body can carry a valid signature (RFC 8301). Subject is not signed: the subject line could have been changed or added.`,
    },
    {
        name: 'recovered key',
        shape: { verdict: 'confirmed-with-caveats', keySource: 'recovered', caveats: ['recovered-key'] },
        sentence: `The message carries a valid DKIM signature of example.com, checked against a key recovered from other signatures. ${LIMITS} The key was recovered from other signatures: it shows that the same key signed these messages, not that it ever belonged to the domain.`,
    },
    {
        name: 'recovered key with a receiver anchor',
        shape: { verdict: 'confirmed-with-caveats', keySource: 'recovered', caveats: ['recovered-key'] },
        options: { receiverPass: true },
        sentence: `The message carries a valid DKIM signature of example.com, checked against a key recovered from other signatures. ${LIMITS} The key was recovered from other signatures: it shows that the same key signed these messages, not that it ever belonged to the domain. ${ANCHOR}`,
    },
    {
        name: 'body altered, nothing explains it',
        shape: { verdict: 'body-altered' },
        sentence: `A DKIM signature of example.com is present, but the body of this message is not the body that was signed. The text of the body is not the text that was signed: something was added, removed or changed after signing. ${NOT_ALONE}`,
    },
    {
        name: 'body altered, an export artefact explains it',
        shape: { verdict: 'body-altered', artefact: 'dot-stuffing' },
        sentence:
            'A DKIM signature of example.com is present, but the body of this message is not the body that was signed. Lines that start with a dot were written with two dots, and with that undone the signature matches. The body was most likely changed by the export, not by a person. The verdict stays body altered: this is an explanation, not a confirmation.',
    },
    {
        name: 'body altered, no key to authenticate the claimed hash',
        shape: { verdict: 'body-altered', caveats: ['body-hash-unauthenticated'] },
        sentence: `A DKIM signature of example.com is present, but the body of this message is not the body that was signed. The text of the body is not the text that was signed: something was added, removed or changed after signing. ${NOT_ALONE} No public key is available, so the body hash claimed in the signature could not be confirmed as the signer’s. Whoever changed the body could have rewritten the hash too.`,
    },
    {
        name: 'headers altered',
        shape: { verdict: 'headers-altered' },
        sentence: `A DKIM signature of example.com is present, but a header field it covers is not what was signed. The body is intact, but at least one header field covered by the signature (such as From, Subject or Date) is not what was signed. The signature cannot say which one. ${NOT_ALONE}`,
    },
    {
        name: 'headers altered, key newer than the message',
        shape: { verdict: 'headers-altered', caveats: ['key-newer-than-message'] },
        sentence:
            'A DKIM signature of example.com is present, but a header field it covers is not what was signed. The body is intact, but the header signature does not verify. The key we hold was first seen after this message was sent, so the sender may have replaced it since: this may be a wrong key rather than an edit.',
    },
    {
        name: 'unverifiable, no key',
        shape: { verdict: 'unverifiable', reason: 'no-key' },
        sentence: `A DKIM signature of example.com is present, but it could not be checked. The message is signed, but the public key s1._domainkey.example.com that checks the signature is not in this case. ${NOTHING}`,
    },
    {
        name: 'unverifiable, no key, with a receiver anchor',
        shape: { verdict: 'unverifiable', reason: 'no-key' },
        options: { receiverPass: true, verifiedOn: '2026-11-11' },
        sentence: `A DKIM signature of example.com is present, but it could not be checked. The message is signed, but the public key s1._domainkey.example.com that checks the signature is not in this case. ${NOTHING} ${ANCHOR} Checked on 2026-11-11.`,
    },
    {
        name: 'unverifiable, reason unknown',
        shape: { verdict: 'unverifiable' },
        sentence: `A DKIM signature of example.com is present, but it could not be checked. ${NOTHING}`,
    },
];

export default async () => {
    await describe('citation sentence', async () => {
        for (const row of ROWS) {
            await it(row.name, async () => {
                expect(citationFor(finding(row.shape), row.options)).toStrictEqual(row.sentence);
            });
        }

        await it('is one paragraph of whole sentences', async () => {
            for (const row of ROWS) {
                const sentence = citationFor(finding(row.shape), row.options);
                expect(sentence.includes('\n')).toBe(false);
                expect(sentence.endsWith('.')).toBe(true);
                expect(sentence.includes('{')).toBe(false);
            }
        });
    });
};
