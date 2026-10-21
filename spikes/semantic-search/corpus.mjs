// The texts the benchmark embeds. NOTHING REAL IS IN HERE — invented mails, reserved example
// domains (RFC 2606), the same rule as tools/make-archive-fixtures.mjs: Stamped is a tool for
// leaked mail, and a real message in a benchmark is as dangerous as one in a fixture.
//
// TWO KINDS OF TEXT, for two different questions.
//
// `pairs` answer "does the model find the right mail?". Each query is phrased the way a journalist
// would ask, and deliberately shares (almost) no word with the mail it should find — the case
// where FTS5 returns nothing and a vector search earns its keep. Half are German, half English,
// and three cross the language (German query, English mail and back), because leaks are mixed.
//
// `throughputDocs()` answers "how long does indexing an archive take?". It builds mail-shaped
// bodies of a realistic length from a sentence pool, deterministic so two machines embed the same
// tokens and their numbers compare.

/** A mail as the index would see it: the subject as title, the body as text. */
export const mails = [
    {
        id: 'zypern',
        subject: 'Re: Freigabe',
        body: 'Hallo Jens, die Überweisung an die Holding in Limassol habe ich am Freitag abgezeichnet. Bitte nicht über das normale Konto laufen lassen, sondern wie besprochen über die Treuhand. Gruß, M.',
    },
    {
        id: 'shredder',
        subject: 'Archiv Keller',
        body: 'Die Ordner aus 2019 und 2020 sollen bis Monatsende weg. Der Dienstleister kommt Dienstag mit dem Container, bitte vorher nichts einscannen.',
    },
    {
        id: 'gutachten',
        subject: 'Entwurf v3',
        body: 'Anbei die überarbeitete Fassung. Den Absatz zu den Grenzwerten habe ich wie gewünscht entschärft, die Messreihe aus Werk 2 taucht nicht mehr auf.',
    },
    {
        id: 'spende',
        subject: 'Unterstützung Wahlkampf',
        body: 'Wir würden uns erkenntlich zeigen, wenn die Genehmigung für das Gewerbegebiet vor der Sommerpause durch den Ausschuss geht. Details lieber telefonisch.',
    },
    {
        id: 'kuendigung',
        subject: 'Personalie Hoffmann',
        body: 'Frau Hoffmann hat intern auf die Unregelmäßigkeiten hingewiesen. Ich schlage vor, ihren befristeten Vertrag nicht zu verlängern und das mit Umstrukturierung zu begründen.',
    },
    {
        id: 'lobby',
        subject: 'Formulierungshilfe',
        body: 'Wie besprochen schicke ich Ihnen unseren Textvorschlag für Paragraf 4. Es wäre gut, wenn er so in die Vorlage des Ministeriums übernommen wird, ohne Hinweis auf uns.',
    },
    {
        id: 'invoice',
        subject: 'Consulting fees Q3',
        body: 'Please issue the invoice for "strategic advisory" as agreed, 12 sessions. Nobody will ask what the sessions covered. Send it to the address in Dubai, not to head office.',
    },
    {
        id: 'leak-hunt',
        subject: 'Re: the article',
        body: 'Legal wants the names of everyone who had access to the board minutes before Thursday. IT can pull the badge and printer logs, keep this between the three of us.',
    },
    {
        id: 'emissions',
        subject: 'test bench settings',
        body: 'For the certification run, switch the unit to calibration mode 7. It only holds on the dyno; on the road the values go back to normal after twenty minutes.',
    },
    {
        id: 'data-sale',
        subject: 'customer list',
        body: 'The partner in Singapore will pay per record for the loyalty-card data including addresses and purchase history. Marketing should not be copied on this thread.',
    },
    {
        id: 'safety',
        subject: 'Kran 3',
        body: 'The inspection sticker on crane 3 expired in March. Keep it running until the project is handed over, the inspector only comes on Mondays anyway.',
    },
    {
        id: 'backdate',
        subject: 'Vertrag Datum',
        body: 'Can you print the agreement again with the old letterhead and put the 14th of February on it? It has to look like it was signed before the board decision.',
    },
];

/** Plausible mail that answers none of the queries — the haystack the needles hide in. */
export const distractors = [
    {
        subject: 'Mittagessen',
        body: 'Gehen wir heute zum Italiener oder lieber in die Kantine? Ich hätte ab halb eins Zeit.',
    },
    { subject: 'Urlaub', body: 'Ich bin vom 3. bis 17. August nicht da, Vertretung macht Frau Kaya.' },
    {
        subject: 'Druckerpapier',
        body: 'Im zweiten Stock ist das Papier alle, kann jemand bei der Beschaffung nachbestellen?',
    },
    {
        subject: 'Weihnachtsfeier',
        body: 'Die Feier findet dieses Jahr am 12. Dezember im Ratskeller statt, bitte bis Freitag zusagen.',
    },
    {
        subject: 'Server Wartung',
        body: 'Am Samstag zwischen 22 und 2 Uhr ist das Intranet wegen Wartungsarbeiten nicht erreichbar.',
    },
    {
        subject: 'Parkplatz',
        body: 'Ab Montag ist die Tiefgarage wegen Bauarbeiten gesperrt, bitte auf den Hof ausweichen.',
    },
    {
        subject: 'Newsletter',
        body: 'Unser Quartalsnewsletter ist fertig, Feedback bis Mittwoch an das Kommunikationsteam.',
    },
    {
        subject: 'team offsite',
        body: 'The offsite is confirmed for the second week of May, the hotel is booked for two nights.',
    },
    {
        subject: 'laptop refresh',
        body: 'Old laptops have to be returned to IT before the new ones are handed out next week.',
    },
    {
        subject: 'quarterly all-hands',
        body: 'Slides for the all-hands are in the shared folder, please add your department update.',
    },
    {
        subject: 'coffee machine',
        body: 'The coffee machine on floor four is broken again, facilities has been informed.',
    },
    {
        subject: 'travel policy',
        body: 'From July on, train is mandatory for trips under four hours, flights need approval.',
    },
    { subject: 'welcome', body: 'Please welcome our new colleague in accounting, she starts on Monday.' },
    { subject: 'Re: Termin', body: 'Donnerstag 15 Uhr passt mir, ich schicke eine Einladung.' },
    {
        subject: 'Fortbildung',
        body: 'Die Excel-Schulung wird auf Oktober verschoben, die Anmeldungen bleiben gültig.',
    },
    {
        subject: 'Jahresabschluss',
        body: 'Die Steuerberatung braucht die Belege für Dezember bis zum 20. Januar vollständig.',
    },
];

/** Query → id of the one mail it should find. `lang` is query→mail, so `de→en` crosses over. */
export const pairs = [
    {
        query: 'Wer hat Geld an eine Briefkastenfirma im Ausland freigegeben?',
        expect: 'zypern',
        lang: 'de→de',
    },
    {
        query: 'Wurden Unterlagen vernichtet, bevor sie jemand sehen konnte?',
        expect: 'shredder',
        lang: 'de→de',
    },
    { query: 'Hat jemand ein Gutachten geschönt?', expect: 'gutachten', lang: 'de→de' },
    { query: 'Bestechung eines Politikers für eine Baugenehmigung', expect: 'spende', lang: 'de→de' },
    { query: 'Wurde eine Whistleblowerin bestraft?', expect: 'kuendigung', lang: 'de→de' },
    { query: 'Hat ein Verband einen Gesetzestext selbst geschrieben?', expect: 'lobby', lang: 'de→de' },
    { query: 'fake invoices for services that never happened', expect: 'invoice', lang: 'en→en' },
    { query: 'they are trying to find out who talked to the press', expect: 'leak-hunt', lang: 'en→en' },
    { query: 'defeat device cheating on the exhaust test', expect: 'emissions', lang: 'en→en' },
    { query: 'Wurden Kundendaten an Dritte verkauft?', expect: 'data-sale', lang: 'de→en' },
    { query: 'Sicherheitsmängel auf der Baustelle wurden ignoriert', expect: 'safety', lang: 'de→en' },
    { query: 'document dated earlier than it was actually signed', expect: 'backdate', lang: 'en→de' },
];

const sentences = [
    'Vielen Dank für die schnelle Rückmeldung zu den offenen Punkten aus der letzten Runde.',
    'Wie am Telefon besprochen, fasse ich die Ergebnisse unseres Termins hier noch einmal zusammen.',
    'Die Zahlen für das dritte Quartal liegen inzwischen vor und weichen leicht von der Planung ab.',
    'Bitte prüfen Sie den beigefügten Entwurf und geben Sie mir bis Ende der Woche Bescheid.',
    'Der Lieferant hat angekündigt, dass sich die Auslieferung um etwa zwei Wochen verzögert.',
    'Für die Sitzung am Donnerstag brauche ich noch die aktualisierte Fassung der Präsentation.',
    'Aus rechtlicher Sicht sehe ich keine Bedenken, solange die Frist eingehalten wird.',
    'Thanks for sending the updated figures, I have forwarded them to the regional team.',
    'As discussed, we will postpone the decision until the audit report is available.',
    'Please find attached the revised schedule; the key milestones have not changed.',
    'The client asked for a short summary of the risks before signing the extension.',
    'I spoke to procurement this morning and they can approve the order next week.',
    'Let me know if you need anything else from my side before the meeting.',
    'Mit freundlichen Grüßen aus der Zentrale, und ein schönes Wochenende.',
];

/**
 * `count` mail bodies of roughly `targetWords` words each, built from the sentence pool by a
 * fixed walk — the same input on every machine, so a MacBook Air and an i9 measure the same
 * tokens. Words, not tokens, because the tokenizer differs per model; the benchmark counts the
 * real tokens per model after the fact.
 */
export function throughputDocs(count, targetWords) {
    const docs = [];
    for (let i = 0; i < count; i++) {
        const parts = [];
        let words = 0;
        for (let j = 0; words < targetWords; j++) {
            const s = sentences[(i * 7 + j * 3) % sentences.length];
            parts.push(s);
            words += s.split(' ').length;
        }
        docs.push({ subject: `Projekt ${(i % 23) + 1}: Stand`, body: parts.join(' ') });
    }
    return docs;
}
