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
const baseMails = [
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
const baseDistractors = [
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
const basePairs = [
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

// ─── The grown corpus ────────────────────────────────────────────────────────────────────────────
// Each entry below is a target mail AND the query that should find it, so the pair cannot drift from
// its mail. `lexical: true` marks the few queries that DO share keywords with their mail (the case FTS5
// already solves — reported separately so it does not flatter the semantic numbers); `hard: true` says a
// topically close mail that does NOT answer the query sits in `hardDistractors`.
const extraDe = [
    {
        id: 'rueckfluss',
        subject: 'Re: Darlehen',
        body: 'Das Geld für die Beraterfirma sollten wir erst nach der Wahl zurückfließen lassen, damit nichts auffällt. Herr Brandt stellt die Quittung später aus.',
        query: 'Wurde eine verdeckte Parteifinanzierung verschleiert?',
        lang: 'de→de',
    },
    {
        id: 'altlast',
        subject: 'Bodenproben Gewerbepark',
        body: 'Die Probe vom Nordrand enthält deutlich mehr Schwermetalle als erlaubt. Ich schlage vor, die Fläche trotzdem als unbedenklich zu melden, sonst steht der Verkauf auf der Kippe.',
        query: 'Wurde die Verseuchung eines Grundstücks verschwiegen?',
        lang: 'de→de',
    },
    {
        id: 'nachtdienst',
        subject: 'Dienstplan Station 2',
        body: 'Nachts haben wir nur noch eine Kraft für 40 Bewohner. Für die Prüfung am Donnerstag tragen wir trotzdem drei ein, die Unterschriften holen wir nachträglich.',
        query: 'Wurde bei einer Heimaufsicht über die Personalstärke getäuscht?',
        lang: 'de→de',
    },
    {
        id: 'vorabinfo',
        subject: 'Angebot Straßenbau',
        body: 'Ich habe Ihnen die Leistungsbeschreibung vorab angehängt, dann liegen Sie bei der Ausschreibung vorn. Die anderen Bieter bekommen die Unterlagen erst morgen.',
        query: 'Wurde ein Auftrag an einen Wunschkandidaten manipuliert vergeben?',
        lang: 'de→de',
    },
    {
        id: 'hafen',
        subject: 'Containerabfertigung',
        body: 'Der Beamte am Hafen lässt die Ware durch, wenn der Umschlag wie letztes Mal im Handschuhfach liegt. 800 pro Lieferung.',
        query: 'Wird ein Zöllner bestochen?',
        lang: 'de→de',
    },
    {
        id: 'studie',
        subject: 'Nebenwirkungen',
        body: "Die drei Todesfälle aus Studienarm B müssen im Abschlussbericht nicht einzeln auftauchen. Fasst sie unter 'sonstige Ereignisse' zusammen.",
        query: 'Wurden Ergebnisse einer Medikamentenerprobung beschönigt?',
        lang: 'de→de',
        hard: true,
    },
    {
        id: 'praktikant',
        subject: 'Baustelle Ost',
        body: 'Die Arbeiter aus Rumänien bekommen weiter 4 Euro die Stunde bar auf die Hand. Auf dem Papier laufen sie als Praktikanten.',
        query: 'Werden Beschäftigte unter dem gesetzlichen Mindestlohn bezahlt und das kaschiert?',
        lang: 'de→de',
    },
    {
        id: 'stall',
        subject: 'Stall 4',
        body: 'Die Veterinärin kündigt sich für Mittwoch an. Bis dahin müssen die verendeten Tiere aus der Halle, und das Antibiotika-Lager gehört in den anderen Schuppen.',
        query: 'Sollen Missstände in einer Mastanlage vor einer Inspektion verschwinden?',
        lang: 'de→de',
    },
    {
        id: 'bonus',
        subject: 'Sonderzahlung',
        body: 'Die Sonderzahlung für die drei Herren läuft nicht über die Gehaltsabrechnung, sondern als Beratungshonorar an ihre Privatgesellschaften. Der Betriebsrat erfährt nichts.',
        query: 'Wie werden Extravergütungen für Manager an der Belegschaftsvertretung vorbeigeschleust?',
        lang: 'de→de',
        hard: true,
    },
    {
        id: 'detektei',
        subject: 'Observation',
        body: 'Der Mann von der Detektei hat die Reporterin zwei Wochen lang begleitet und ihre Treffen fotografiert. Rechnung bitte über die Rechtsabteilung, nicht über die Kommunikation.',
        query: 'Wurde eine Journalistin ausspioniert?',
        lang: 'de→de',
    },
    {
        id: 'fass',
        subject: 'Halle 6',
        body: 'Die undichten Fässer sind umgelagert, das Messprotokoll bleibt unter Verschluss. Das Landesamt hat nicht nachgefragt, und so soll es bleiben.',
        query: 'Wurde ein Chemieunfall vor der Aufsichtsbehörde geheim gehalten?',
        lang: 'de→de',
    },
    {
        id: 'spesen',
        subject: 'Spesen Mai',
        body: 'Das Wochenende in Südtirol hängen wir als Kundentermin an. Die Hotelrechnung lautet auf die Firma, die Begleitung bitte nicht erwähnen.',
        query: 'Werden private Ausflüge als Dienstreisen abgerechnet?',
        lang: 'de→de',
    },
    {
        id: 'schimmel',
        subject: 'Elternbrief',
        body: 'Bitte den Brief zum Schimmel in den Klassenräumen erst nach den Ferien verschicken. Die Stadt hat kein Geld für die Sanierung und will keine Schlagzeilen.',
        query: 'Wird eine Gesundheitsgefahr an einer Schule heruntergespielt?',
        lang: 'de→de',
    },
    {
        id: 'postfach',
        subject: 'Re: Zugriff',
        body: 'Ich habe die Rechte von Frau Weber gestern entzogen und ihr Postfach gesichert. Wir sollten durchsehen, was sie an Externe weitergeleitet hat.\n\nAm 12. Juni schrieb Anna Muster <anna.muster@example.com>:\n> Frau Weber war bei der Presse, ich bin sicher.\n> Bitte prüfen, bevor sie morgen wieder da ist.\n\n-- \nT. Beispiel\nIT-Betrieb, Beispiel AG',
        query: 'Wird nach einer Informantin im eigenen Haus gesucht?',
        lang: 'de→de',
        hard: true,
    },
    {
        id: 'schwarzgeld',
        subject: 'Re: Re: Grundstück Hafenstraße',
        body: 'Einverstanden, aber der Preis darf nirgends schriftlich stehen. Den Rest regeln wir bar beim Notar.\n\nAm 3. März schrieb Dirk Beispiel <dirk@example.com>:\n> Der Gutachter setzt 400.000 an, wir verkaufen für 650.000.\n> Die Differenz geht an die Stiftung.\n\n-- \nKlaus Muster\nMuster Immobilien GmbH\nTel. 0000 000000',
        query: 'Wird beim Immobilienverkauf Geld am Fiskus vorbeigeschleust?',
        lang: 'de→de',
    },
    {
        id: 'foerder',
        subject: 'Antrag Landesförderung',
        body: 'Die Maschinen stehen noch in Polen, aber für den Verwendungsnachweis brauchen wir Fotos aus dem neuen Werk. Stellt bitte eine Halle so, dass es nach Produktion aussieht.',
        query: 'Wird eine staatliche Subvention erschlichen?',
        lang: 'de→de',
    },
    {
        id: 'gast',
        subject: 'Einladung Jagdwochenende',
        body: 'Der Staatssekretär hat zugesagt. Die Unterbringung übernimmt wie immer die Firma, Gegenleistungen müssen wir nicht ansprechen, die ergeben sich.',
        query: 'Werden Amtsträger mit Annehmlichkeiten gefügig gemacht?',
        lang: 'de→de',
        hard: true,
    },
    {
        id: 'bohrung',
        subject: 'Re: Bohrung Nord',
        body: 'Zur Lage: Die Bohrung hat in 80 Metern Tiefe die Grundwasserschicht angeschnitten, das Wasser im Brunnen der Nachbargemeinde trübt sich seit Dienstag. Das Gutachten, das wir beauftragt haben, kommt zu demselben Schluss, wir sollten es nur nicht weitergeben. Meine Empfehlung: Wir bieten der Gemeinde pauschal eine Unterstützung für die Wasseraufbereitung an, ohne einen Zusammenhang einzuräumen, und lassen uns dafür Verschwiegenheit zusichern. Sollte die Presse fragen, verweisen wir auf natürliche Schwankungen. Die Kollegen vor Ort wissen Bescheid und sprechen nur untereinander darüber. Bitte bestätigen Sie, dass das so laufen soll, bevor ich Herrn Schwarz anrufe. Ich bräuchte die Freigabe bis morgen früh, weil die Gemeinderatssitzung schon am Nachmittag stattfindet und das Thema danach nicht mehr zu steuern ist.',
        query: 'Wird ein Umweltschaden mit Schweigegeld abgefedert?',
        lang: 'de→de',
    },
    {
        id: 'sportler',
        subject: 'Trainingsplan',
        body: 'Die Kur startet nach dem Trainingslager. Der Arzt sagt, die Proben sind bis dahin sauber, wenn wir die Dosierung absetzen. Bitte nichts davon in die Akte.',
        query: 'Wurden Leistungssportler heimlich mit verbotenen Mitteln versorgt?',
        lang: 'de→de',
    },
    {
        id: 'lobby2',
        subject: 'Re: Anhörung',
        body: 'Die Änderung zur Haftungsgrenze kommt, wie von Ihnen gewünscht. Der Ausschussvorsitzende hat zugesagt, sie nicht als Antrag der Fraktion zu kennzeichnen.\n\nAm 9. Mai schrieb Lena Beispiel <lena@example.org>:\n> Wir brauchen die Haftungsgrenze unbedingt bis Ende Juni.\n> Sonst zieht der Konzern seine Investition ab.\n\n-- \nDr. R. Muster\nBüro Abgeordneter, Berlin',
        query: 'Wurde ein Gesetz zugunsten eines Unternehmens zugeschnitten, ohne dass die Urheberschaft sichtbar wurde?',
        lang: 'de→de',
        hard: true,
    },
    {
        id: 'scheinverfahren',
        subject: 'AW: Stelle Leitung',
        body: 'Die Stelle ist für Herrn Krause vorgesehen, das Verfahren ist nur Formsache. Die übrigen Kandidaten laden wir ein, damit es ordentlich aussieht.\n\n-----Ursprüngliche Nachricht-----\nVon: Personal <hr@example.com>\nGesendet: Montag, 4. Mai\nAn: Geschäftsführung\nBetreff: Stelle Leitung\n\n> Sollen wir die Ausschreibung öffentlich machen?\n\n-- \nGeschäftsführung\nBeispiel GmbH',
        query: 'Ist ein Auswahlverfahren nur zum Schein durchgeführt worden?',
        lang: 'de→de',
    },
    {
        id: 'hotel',
        subject: 'Zimmer 14',
        body: 'Die beiden Herren checken getrennt ein, die Rechnung bitte unter Beratung buchen. Keine Namen auf dem Beleg.',
        query: 'Soll ein Aufenthalt in einer Unterkunft nachträglich verschleiert werden?',
        lang: 'de→de',
    },
    {
        id: 'kredit',
        subject: 'Kreditlinie',
        body: 'Die Bilanz zeigt bei den Verbindlichkeiten eine Lücke von rund 40 Millionen. Wir verschieben sie in die Tochter auf den Cayman-Inseln, damit die Bank sie bei der Prüfung nicht sieht.',
        query: 'Wurden Schulden aus der Bilanz versteckt?',
        lang: 'de→de',
        hard: true,
    },
    {
        id: 'bescheid',
        subject: 'Anhörung Fall 214',
        body: 'Der Bescheid ist vorformuliert, die Ablehnung steht fest. Die Anhörung führen wir trotzdem durch, damit die Akte vollständig ist.',
        query: 'Steht das Ergebnis eines behördlichen Verfahrens schon vorher fest?',
        lang: 'de→de',
    },
    {
        id: 'festplatte',
        subject: 'Erledigt',
        body: 'Die Festplatte ist im Rhein, Sache erledigt.',
        query: 'Wurde Beweismaterial beseitigt?',
        lang: 'de→de',
    },
    {
        id: 'absprache',
        subject: 'Fwd',
        body: 'Nicht schriftlich, ruf mich an. Der Minister weiß Bescheid.',
        query: 'Gibt es Hinweise auf eine Absprache an höchster Stelle, die geheim bleiben sollte?',
        lang: 'de→de',
    },
    {
        id: 'lex-kita',
        subject: 'Kita-Gebühren',
        body: 'Die Kita-Gebühren steigen zum 1. August um zehn Prozent, der Elternbeirat wurde informiert.',
        query: 'Kita-Gebühren Erhöhung August',
        lang: 'de→de',
        lexical: true,
    },
    {
        id: 'lex-miete',
        subject: 'Kündigungsfrist Mietvertrag',
        body: 'Zur Klarstellung: Die Kündigungsfrist im Mietvertrag für die Lagerhalle beträgt sechs Monate zum Quartalsende.',
        query: 'Kündigungsfrist Mietvertrag Lagerhalle',
        lang: 'de→de',
        lexical: true,
    },
    {
        id: 'lex-bahn',
        subject: 'Bahnstreik',
        body: 'Wegen des Bahnstreiks am Montag arbeiten alle im Homeoffice, Meetings finden nur per Video statt.',
        query: 'Bahnstreik Montag Homeoffice',
        lang: 'de→de',
        lexical: true,
    },
    {
        id: 'lex-gehalt',
        subject: 'Gehaltsabrechnung Oktober',
        body: 'Die Gehaltsabrechnung für Oktober liegt im Portal, Nachzahlungen werden mit dem November-Gehalt überwiesen.',
        query: 'Gehaltsabrechnung Oktober Nachzahlung',
        lang: 'de→de',
        lexical: true,
    },
];

const extraEn = [
    {
        id: 'shell-chain',
        subject: 'Re: structure',
        body: 'Move the royalty payments through the Maltese entity first, then onward to the trust. On paper the trust has no connection to us.',
        query: 'who set up a chain of companies to hide where the cash ends up',
        lang: 'en→en',
    },
    {
        id: 'brake-sensor',
        subject: 'Brake sensor',
        body: 'The failure rate on the brake sensor is above what we told the regulator. Do not open a field action until the Q4 numbers are out.',
        query: 'did the manufacturer sit on a known product defect',
        lang: 'en→en',
    },
    {
        id: 'exit-note',
        subject: 'HR note',
        body: 'Her access is cut as of tomorrow and the exit interview is moved forward. Make sure nothing in writing links this to her report.',
        query: 'retaliation against an employee who raised concerns',
        lang: 'en→en',
    },
    {
        id: 'bid-tip',
        subject: 'Re: bid',
        body: 'I can tell you the other two offers are at least 5% higher than yours. You may want to adjust before the deadline.',
        query: 'a competitor was given inside knowledge about rival prices',
        lang: 'en→en',
    },
    {
        id: 'river',
        subject: 'river discharge',
        body: 'The filter has been bypassed since January. As long as the sampling point stays upstream of the outlet, the readings stay green.',
        query: 'wastewater being released illegally while the testing looks fine',
        lang: 'en→en',
    },
    {
        id: 'envelope',
        subject: 'Re: permits',
        body: 'The officer expects the envelope before he stamps the files. Last time two thousand did it, this time make it three.',
        query: 'paying a civil servant to speed things up',
        lang: 'en→en',
    },
    {
        id: 'ward5',
        subject: 'ward 5',
        body: 'Infection numbers on ward 5 are not to be reported to the health office until the inspection is over.',
        query: 'hiding a disease outbreak at a clinic',
        lang: 'en→en',
    },
    {
        id: 'ad-budget',
        subject: 'Re: coverage',
        body: 'Please let the editor know the advertising budget is on hold until the piece on us is "reconsidered".',
        query: 'using spending power as leverage against critical reporting',
        lang: 'en→en',
    },
    {
        id: 'old-ledger',
        subject: 'Auditors',
        body: 'Give the auditors the version of the ledger from before the correction. The real one stays on my laptop.',
        query: 'misleading external examiners with doctored books',
        lang: 'en→en',
    },
    {
        id: 'ratings',
        subject: 'Rating boost',
        body: 'Ten more five-star ratings by Friday please, different accounts and different phrasing so the platform does not flag them.',
        query: 'manufactured praise meant to deceive customers',
        lang: 'en→en',
    },
    {
        id: 'relabel',
        subject: 'Re: shipment',
        body: 'Relabel the pallets as agricultural equipment. The end customer is in the country we are not supposed to deliver to.',
        query: 'evading an export ban by mislabelling goods',
        lang: 'en→en',
    },
    {
        id: 'insider',
        subject: 'before Monday',
        body: 'Do not say anything, but the merger is announced Monday. If you have family accounts, now is the time.',
        query: 'trading on confidential knowledge ahead of a public announcement',
        lang: 'en→en',
    },
    {
        id: 'cousin',
        subject: 'thanks',
        body: 'As agreed, 5% of the contract value goes to the account of the deputy minister cousin. Please do not use the company card.',
        query: 'a cut of a public contract returned to an official relative',
        lang: 'en→en',
    },
    {
        id: 'auto-delete',
        subject: 'chat retention',
        body: 'Set the messaging app to delete after 24 hours starting today. Legal said there is no need to tell staff why.',
        query: 'making sure conversations leave no trace',
        lang: 'en→en',
    },
    {
        id: 'young-workers',
        subject: 'supplier visit',
        body: 'The factory kept the young kids out of sight for the audit. They are back on the floor after the auditors leave.',
        query: 'minors employed at a supplier, concealed from inspectors',
        lang: 'en→en',
    },
    {
        id: 'slices',
        subject: 'procurement',
        body: 'Cut the purchase into three invoices, each below the threshold, so no tender is required.',
        query: 'dodging mandatory public bidding by breaking a buy into slices',
        lang: 'en→en',
    },
    {
        id: 'tracking-app',
        subject: 'staff phones',
        body: 'We installed the monitoring app on the staff phones without telling the works council, and it also logs location after hours.',
        query: 'employees secretly followed outside working time',
        lang: 'en→en',
    },
    {
        id: 'screening',
        subject: 'screening',
        body: 'Filter out anyone over fifty and anyone with a foreign name before the interviews. Do not put the criteria in the job ad.',
        query: 'applicants rejected for who they are, not what they can do',
        lang: 'en→en',
    },
    {
        id: 'pension',
        subject: 'Pension fund',
        body: 'Move the pension reserves into the property in which the chairman holds a stake. Trustees will vote it through if we call it diversification.',
        query: 'retirement savings steered into the bosses pet project',
        lang: 'en→en',
    },
    {
        id: 'tailings',
        subject: 'Tailings dam',
        body: 'The crack in the dam wall was photographed in May. Engineering recommends evacuation planning; management recommends not putting it in the minutes.',
        query: 'warnings of a possible catastrophe deliberately kept off the record',
        lang: 'en→en',
    },
    {
        id: 'burn',
        subject: 'ok',
        body: 'Burn the notebook.',
        query: 'an order to destroy a written record',
        lang: 'en→en',
    },
    {
        id: 'beneficiary',
        subject: 'Re: account opening',
        body: 'Thanks for the call. To summarise where we are: the client prefers that the account is opened in the name of the foundation, not in his own name, and that the foundation board consists of two people he knows personally. The bank compliance team will ask for the beneficial owner. We agreed that the form lists the lawyer as the contact and that the real owner is only disclosed verbally if it is ever demanded. Please do not forward this to anyone outside the small group, and delete your earlier draft. I will send the signed forms via courier on Wednesday so there is no trace in the system.\n\nOn Tue, 8 Apr, Sam Example <sam@example.net> wrote:\n> Can we keep his name off the paperwork entirely?\n> I would rather the bank never sees it.\n\n-- \nA. Example\nExample & Partners',
        query: 'hiding the person who really benefits from a deposit',
        lang: 'en→en',
    },
    {
        id: 'lex-parking',
        subject: 'Parking permits',
        body: 'Parking permits for the visitor lot must be renewed by the end of March, contact reception.',
        query: 'visitor parking permits renewal March',
        lang: 'en→en',
        lexical: true,
    },
    {
        id: 'lex-invoice',
        subject: 'Invoice 4471 overdue',
        body: 'Invoice 4471 from the catering supplier is overdue by 30 days, please release the payment.',
        query: 'overdue catering invoice 4471',
        lang: 'en→en',
        lexical: true,
    },
    {
        id: 'lex-agenda',
        subject: 'Board meeting agenda',
        body: 'The agenda for the board meeting on 14 June is attached, please send comments by Friday.',
        query: 'board meeting agenda 14 June',
        lang: 'en→en',
        lexical: true,
    },
];

const extraCross = [
    {
        id: 'stadium',
        subject: 'Sponsorship',
        body: 'We can fund the new stand of the football club if the council moves the stadium zoning forward. Your call who tells the mayor.',
        query: 'Sollte ein Bauvorhaben im Gegenzug für Zuwendungen an einen Verein durchgewunken werden?',
        lang: 'de→en',
    },
    {
        id: 'breach',
        subject: 'Breach',
        body: 'The customer database was copied last Tuesday. We have not told the data protection authority and will not unless somebody outside finds out.',
        query: 'Wurde ein Hackerangriff den Behörden verschwiegen?',
        lang: 'de→en',
    },
    {
        id: 'thesis',
        subject: 'Thesis',
        body: 'The minister thesis was largely written by the agency; he only signed it. Keep the invoices separate.',
        query: 'Hat ein Politiker seine Abschlussarbeit nicht selbst verfasst?',
        lang: 'de→en',
    },
    {
        id: 'headcount',
        subject: 'Re: grants',
        body: 'Count the volunteers as full-time staff for the report; the ministry will not check payroll.',
        query: 'Werden Zuschüsse durch geschönte Mitarbeiterzahlen erschlichen?',
        lang: 'de→en',
    },
    {
        id: 'tenants',
        subject: 'Tenants',
        body: 'Make the heating fail for two weeks in the old building. Most of them will move out on their own, then we can renovate and double the rent.',
        query: 'Werden Mieter absichtlich aus ihren Wohnungen gedrängt?',
        lang: 'de→en',
    },
    {
        id: 'sterility',
        subject: 'batch 22',
        body: 'The test batch failed sterility twice. Ship it anyway, the next one will be better.',
        query: 'Wurden fehlerhafte Medizinprodukte trotzdem ausgeliefert?',
        lang: 'de→en',
    },
    {
        id: 'abitur',
        subject: 'Prüfungsnoten',
        body: 'Die Abiturnoten der Söhne der Sponsoren müssen um einen Punkt angehoben werden. Bitte nicht im System ändern, sondern nur im Zeugnisentwurf.',
        query: 'grades quietly raised for the children of donors',
        lang: 'en→de',
    },
    {
        id: 'video',
        subject: 'Einsatz',
        body: 'Das Video vom Einsatz am Bahnhof ist weg, die Kamera hatte laut Protokoll einen Defekt. Der Kollege hat es nicht gelöscht, aber auch nicht gesichert.',
        query: 'footage of a police operation conveniently missing',
        lang: 'en→de',
    },
    {
        id: 'wasser',
        subject: 'Wasserpreise',
        body: 'Die Kalkulation der Wassergebühren enthält die Rücklage für den Neubau des Vereinshauses. Der Prüfer muss das nicht erfahren.',
        query: 'citizens overcharged for utilities through hidden items',
        lang: 'en→de',
    },
    {
        id: 'karteileichen',
        subject: 'Mitgliederliste',
        body: 'Wir führen noch 400 Mitglieder, die seit Jahren nicht mehr zahlen, damit der Zuschuss nicht sinkt.',
        query: 'inflated numbers to keep public funding',
        lang: 'en→de',
    },
    {
        id: 'tierversuch',
        subject: 'Versuchsreihe 8',
        body: 'Die Genehmigung gilt nur für 20 Tiere, wir brauchen aber 60. Die Differenz tragen wir als Ausschuss ein.',
        query: 'laboratory experiments exceeding what was approved',
        lang: 'en→de',
    },
    {
        id: 'folgemandat',
        subject: 'Gutachter',
        body: 'Der Gutachter hat angedeutet, dass er für ein Folgemandat die Ergebnisse gern in unserem Sinne formuliert.',
        query: 'an expert hinting his findings depend on future work',
        lang: 'en→de',
    },
    {
        id: 'briefwahl',
        subject: 'Briefwahl',
        body: 'Die Anträge für die Briefwahl füllen wir für die Heimbewohner aus, sie müssen nur noch unterschreiben. Wen sie wählen, steht schon drin.',
        query: 'residents of a home having their ballot decisions made for them',
        lang: 'en→de',
    },
];

/**
 * HARD distractors: each is topically close to the target named in `for` and does NOT answer its query —
 * the legitimate invoice next to the fake one. A model that only matches the topic ranks these above the
 * target; a model that reads the meaning does not.
 */
const hardDistractors = [
    {
        for: 'zypern',
        subject: 'Überweisung Tochter Limassol',
        body: 'Die Überweisung an unsere Tochtergesellschaft in Limassol ist über das reguläre Konto gelaufen, der Darlehensvertrag liegt der Buchhaltung vor.',
    },
    {
        for: 'shredder',
        subject: 'Aufbewahrungsfristen',
        body: 'Unterlagen, deren gesetzliche Aufbewahrungsfrist abgelaufen ist, gehen turnusmäßig zur Vernichtung. Die Liste liegt dem Datenschutzbeauftragten vor.',
    },
    {
        for: 'gutachten',
        subject: 'Gutachten Rückmeldung',
        body: 'Die Anmerkungen der Fachabteilung sind eingearbeitet, die Messreihe aus Werk 2 steht jetzt vollständig im Anhang.',
    },
    {
        for: 'spende',
        subject: 'Parteispende 2024',
        body: 'Die Spende an den Ortsverband wurde ordnungsgemäß verbucht und im Rechenschaftsbericht veröffentlicht. Eine Gegenleistung gibt es nicht.',
    },
    {
        for: 'kuendigung',
        subject: 'Vertragsende Hoffmann',
        body: 'Der befristete Vertrag von Frau Hoffmann läuft wie vereinbart aus, wir danken ihr für die gute Zusammenarbeit und bieten ein Zeugnis an.',
    },
    {
        for: 'lobby',
        subject: 'Stellungnahme Verband',
        body: 'Unsere Stellungnahme zum Referentenentwurf ist beim Ministerium eingereicht und auf der Verbandsseite öffentlich einsehbar.',
    },
    {
        for: 'invoice',
        subject: 'Consulting invoice Q3',
        body: 'Attached is the invoice for the 12 workshop days delivered in Q3, with timesheets and the signed attendance lists. Please pay to the account on file.',
    },
    {
        for: 'leak-hunt',
        subject: 'Access log review',
        body: 'As every year, IT reviews the access logs for the board portal for the audit committee. The report goes to the committee chair only.',
    },
    {
        for: 'emissions',
        subject: 'dyno schedule',
        body: 'The dyno is booked for the certification run on Tuesday. Please use the standard calibration set that was approved by the authority.',
    },
    {
        for: 'data-sale',
        subject: 'data processing agreement',
        body: 'The agreement with our Singapore partner covers only aggregated, anonymised statistics. Legal and the data protection officer signed off.',
    },
    {
        for: 'safety',
        subject: 'Kran 3 Prüfung',
        body: 'Crane 3 passed the inspection on Monday, the new sticker is on and the certificate is in the site folder.',
    },
    {
        for: 'backdate',
        subject: 'Vertrag unterzeichnet',
        body: 'Der Vertrag wurde am 14. Februar vom Vorstand unterzeichnet, eine Kopie liegt im Vertragsregister.',
    },
    {
        for: 'studie',
        subject: 'Sicherheitsbericht Studie',
        body: 'Alle schwerwiegenden Ereignisse aus Studienarm B sind einzeln im Abschlussbericht aufgeführt und der Ethikkommission gemeldet worden.',
    },
    {
        for: 'bonus',
        subject: 'Bonusrunde',
        body: 'Die Boni werden mit der Gehaltsabrechnung ausgezahlt, die Summen hat der Betriebsrat in der Sitzung am Dienstag geprüft und gebilligt.',
    },
    {
        for: 'postfach',
        subject: 'Austritt Postfach',
        body: 'Beim Ausscheiden eines Mitarbeiters sichern wir das Postfach nach Richtlinie für 90 Tage und löschen es danach.',
    },
    {
        for: 'gast',
        subject: 'Einladung Fachkonferenz',
        body: 'Die Teilnahme des Staatssekretärs an unserer Fachkonferenz ist im Transparenzregister vermerkt; er trägt seine Reisekosten selbst.',
    },
    {
        for: 'lobby2',
        subject: 'Änderungsantrag Haftung',
        body: 'Der Änderungsantrag zur Haftungsgrenze wurde von der Fraktion offen eingebracht und in der Anhörung diskutiert.',
    },
    {
        for: 'kredit',
        subject: 'Bilanz Verbindlichkeiten',
        body: 'Die Verbindlichkeiten sind vollständig ausgewiesen, die Kreditlinie wurde im März planmäßig bedient.',
    },
    {
        for: 'hafen',
        subject: 'Zollanmeldung',
        body: 'Die Zollanmeldung für die Containerlieferung ist elektronisch eingereicht, die Abgaben sind überwiesen.',
    },
    {
        for: 'altlast',
        subject: 'Bodenproben Ergebnis',
        body: 'Die Bodenproben vom Nordrand liegen unter allen Grenzwerten, der Bericht geht an das Umweltamt.',
    },
    {
        for: 'nachtdienst',
        subject: 'Dienstplan Nachtschicht',
        body: 'Die Nachtschicht ist mit drei Kräften besetzt, zwei weitere stehen in Rufbereitschaft. Die Heimaufsicht hat den Plan geprüft.',
    },
    {
        for: 'vorabinfo',
        subject: 'Ausschreibung Straßenbau',
        body: 'Die Leistungsbeschreibung wurde gestern an alle Bieter gleichzeitig verschickt, Fragen werden öffentlich beantwortet.',
    },
    {
        for: 'praktikant',
        subject: 'Mindestlohn Baustelle',
        body: 'Alle Beschäftigten auf der Baustelle Ost werden nach Tarif bezahlt, die Stundennachweise liegen der Zollprüfung vor.',
    },
    {
        for: 'stall',
        subject: 'Stall 4 Kontrolle',
        body: 'Die Veterinärin war da und hat nichts beanstandet. Die Dokumentation der Medikamente ist vollständig.',
    },
    {
        for: 'spesen',
        subject: 'Reisekosten Südtirol',
        body: 'Die Reise nach Südtirol war ein Kundentermin mit Agenda; Belege und Teilnehmerliste sind der Abrechnung beigefügt.',
    },
    {
        for: 'schimmel',
        subject: 'Schimmel Klassenräume',
        body: 'Der Elternbrief zur Schimmelsanierung geht heute raus, die Stadt hat das Geld bewilligt, die Arbeiten starten in den Ferien.',
    },
    {
        for: 'foerder',
        subject: 'Verwendungsnachweis',
        body: 'Der Verwendungsnachweis mit Fotos aus dem neuen Werk ist eingereicht, die Maschinen laufen seit Juni.',
    },
    {
        for: 'shell-chain',
        subject: 'holding structure',
        body: 'The Maltese entity is our regular licensing subsidiary; the group structure chart is attached and filed with the tax office.',
    },
    {
        for: 'brake-sensor',
        subject: 'Brake sensor field action',
        body: 'We opened a field action for the brake sensor and informed the regulator yesterday. Dealers will contact affected owners.',
    },
    {
        for: 'exit-note',
        subject: 'Offboarding',
        body: 'Her last day is Friday as planned; access is removed after the handover. The exit interview is voluntary.',
    },
    {
        for: 'bid-tip',
        subject: 'bid questions',
        body: 'All questions and answers on the bid have been published to every bidder at the same time, as the rules require.',
    },
    {
        for: 'river',
        subject: 'Discharge report',
        body: 'The quarterly discharge report is attached; sampling happens downstream of the outlet and values are within permit limits.',
    },
    {
        for: 'envelope',
        subject: 'permit fees',
        body: 'The permit fee is paid by bank transfer to the municipality, the receipt is attached to the application.',
    },
    {
        for: 'ward5',
        subject: 'infection report',
        body: 'Ward 5 reported the infection numbers to the health office this morning, as required by law.',
    },
    {
        for: 'ad-budget',
        subject: 'advertising plan',
        body: 'The advertising budget for next year is approved; placement follows audience data, not editorial content.',
    },
    {
        for: 'old-ledger',
        subject: 'audit documents',
        body: 'The auditors received the final ledger including all corrections, with the change log for each entry.',
    },
    {
        for: 'ratings',
        subject: 'review request',
        body: 'Please send the review request email to customers who bought in the last month. Reviews are posted unedited.',
    },
    {
        for: 'relabel',
        subject: 'export licence',
        body: 'The export licence for the agricultural equipment shipment was granted, the end user declaration is attached.',
    },
    {
        for: 'insider',
        subject: 'trading window',
        body: 'A reminder: the trading window is closed until the results are published. Please check with compliance before any transaction.',
    },
    {
        for: 'cousin',
        subject: 'contract award',
        body: 'The contract was awarded to the lowest bidder after a public tender; the evaluation protocol is available on request.',
    },
    {
        for: 'auto-delete',
        subject: 'retention policy',
        body: 'The retention policy is unchanged: chat messages are kept for two years and exported to the archive for legal hold.',
    },
    {
        for: 'young-workers',
        subject: 'supplier audit',
        body: 'The supplier audit confirmed age checks at the gate; no one under eighteen is employed, records were reviewed on site.',
    },
    {
        for: 'slices',
        subject: 'procurement plan',
        body: 'Purchases above the threshold go through the tender portal; the three framework orders were bundled to get a better price.',
    },
    {
        for: 'tracking-app',
        subject: 'mobile device policy',
        body: 'The works council approved the mobile device policy; location tracking is off outside working hours and staff can inspect the data.',
    },
    {
        for: 'screening',
        subject: 'recruiting',
        body: 'Applications are reviewed anonymously, and the criteria listed in the job ad are the only ones applied in the interviews.',
    },
    {
        for: 'pension',
        subject: 'Pension fund report',
        body: 'The trustees reviewed the pension reserves; the portfolio is diversified across bonds and listed funds, the audit found no conflicts.',
    },
    {
        for: 'tailings',
        subject: 'dam inspection',
        body: 'The annual dam inspection found no cracks; the report is filed and shared with the regional authority.',
    },
    {
        for: 'beneficiary',
        subject: 'KYC form',
        body: 'The client onboarding form lists the beneficial owner by name, as the bank requires, and the compliance team has verified the ID.',
    },
    {
        for: 'stadium',
        subject: 'sponsoring football club',
        body: 'Our sponsorship of the football club is published on our website; it has no connection to any planning decision.',
    },
    {
        for: 'breach',
        subject: 'incident report',
        body: 'The database incident was reported to the data protection authority within 72 hours and affected customers have been notified.',
    },
    {
        for: 'thesis',
        subject: 'Dissertation',
        body: 'The minister published his dissertation with full acknowledgements; the university committee found no issues.',
    },
    {
        for: 'headcount',
        subject: 'grant report',
        body: 'Staff numbers in the grant report are based on payroll, with volunteers listed separately as the ministry template asks.',
    },
    {
        for: 'tenants',
        subject: 'Sanierung Altbau',
        body: 'Die Mieter wurden schriftlich über die Sanierung informiert, die Heizung wird erst im Sommer erneuert und die Mieten bleiben gedeckelt.',
    },
    {
        for: 'sterility',
        subject: 'batch 22 retest',
        body: 'Batch 22 failed sterility testing and was quarantined; it will be destroyed and the root cause investigated.',
    },
    {
        for: 'abitur',
        subject: 'Notenkonferenz',
        body: 'Die Abiturnoten wurden in der Notenkonferenz beschlossen und im System festgeschrieben; Widersprüche sind bis Freitag möglich.',
    },
    {
        for: 'video',
        subject: 'Einsatzvideo',
        body: 'Das Video vom Einsatz am Bahnhof ist gesichert und liegt der Staatsanwaltschaft vor.',
    },
    {
        for: 'wasser',
        subject: 'Gebührenkalkulation',
        body: 'Die Kalkulation der Wassergebühren wurde vom Prüfer abgenommen und enthält nur Betriebskosten und die gesetzliche Rücklage.',
    },
    {
        for: 'karteileichen',
        subject: 'Mitgliederbestand',
        body: 'Wir haben die Mitgliederliste bereinigt und 400 inaktive Einträge gestrichen; der Zuschuss wird neu berechnet.',
    },
    {
        for: 'tierversuch',
        subject: 'Versuchsreihe 8',
        body: 'Die Versuchsreihe 8 nutzt genau die genehmigten 20 Tiere; jede Abweichung würde der Behörde gemeldet.',
    },
    {
        for: 'folgemandat',
        subject: 'Gutachterauswahl',
        body: 'Der Gutachter wurde nach Ausschreibung bestimmt; ein Folgemandat ist weder zugesagt noch an Ergebnisse geknüpft.',
    },
    {
        for: 'briefwahl',
        subject: 'Briefwahl Heim',
        body: 'Die Heimbewohner werden beim Ausfüllen der Briefwahlunterlagen nur auf Wunsch und neutral unterstützt.',
    },
];

/** Everyday mail that answers none of the queries and is close to none of the targets. */
const fillerDistractors = [
    [
        'Besprechungsraum',
        'Raum 2.14 ist am Donnerstag von 10 bis 12 Uhr für unser Planungsgespräch reserviert.',
    ],
    ['Geburtstag', 'Wir sammeln für ein Geschenk für Ines, bitte bis Freitag in die Kasse am Empfang.'],
    [
        'Aufzug defekt',
        'Der Aufzug im Haupteingang ist bis Mittwoch außer Betrieb, bitte das Treppenhaus nutzen.',
    ],
    [
        'Passwort',
        'Das Passwort für das Gäste-WLAN ändert sich zum Monatsersten, es hängt dann an der Rezeption.',
    ],
    [
        'Protokoll',
        'Das Protokoll der Teamsitzung vom Dienstag liegt im Ordner, bitte Ergänzungen bis morgen.',
    ],
    [
        'Fahrrad-Leasing',
        'Das Angebot für das Fahrrad-Leasing gilt noch bis Ende des Monats, Infos im Intranet.',
    ],
    ['Schlüssel', 'Ein Schlüsselbund wurde in der Küche gefunden, abzuholen bei der Hausverwaltung.'],
    [
        'Handout Workshop',
        'Die Unterlagen für den Workshop am Freitag habe ich ausgedruckt, 20 Exemplare reichen hoffentlich.',
    ],
    [
        'Urlaubsvertretung',
        'Während meiner Abwesenheit erreichen Sie mich nur eingeschränkt, dringende Fragen gehen an das Sekretariat.',
    ],
    [
        'Catering',
        'Für die Veranstaltung am 5. bestellen wir Fingerfood und vegetarische Optionen, bitte Allergien melden.',
    ],
    ['Reinigung', 'Die Reinigungsfirma kommt ab nächster Woche schon um sechs Uhr morgens.'],
    ['Feiertag', 'Am Brückentag bleibt das Büro geschlossen, die Hotline ist über die Zentrale erreichbar.'],
    ['Visitenkarten', 'Die neuen Visitenkarten sind da, abzuholen im Sekretariat.'],
    [
        'Software-Update',
        'Das Update für das Buchhaltungsprogramm wird am Wochenende eingespielt, Montag ist mit kurzen Ladezeiten zu rechnen.',
    ],
    ['Teamfoto', 'Das Teamfoto ist am Mittwoch um 11 Uhr im Innenhof, bitte pünktlich.'],
    ['Dienstreise', 'Der Zug nach Hamburg fährt um 7:42 Uhr, die Tickets sind im Postfach.'],
    [
        'Sitzungsprotokoll',
        'Anbei das Protokoll der Gesellschafterversammlung zur Kenntnis, Beschlüsse sind markiert.',
    ],
    [
        'Rechnungseingang',
        'Die Rechnung des Büromaterial-Lieferanten ist eingegangen und zur Zahlung freigegeben.',
    ],
    [
        'Schulung Brandschutz',
        'Die jährliche Brandschutzunterweisung findet am 18. um 14 Uhr im großen Saal statt.',
    ],
    ['Kantine', 'Die Kantine bietet diese Woche ein Fischgericht und ein Linsencurry an.'],
    ['Fahrgemeinschaft', 'Ich suche Mitfahrer von Köln nach Düsseldorf, Abfahrt täglich um halb acht.'],
    ['Lieferung', 'Das Paket mit den Monitoren wurde zugestellt und steht beim Pförtner.'],
    ['Umfrage', 'Bitte nehmen Sie sich fünf Minuten Zeit für die Mitarbeiterumfrage, sie läuft bis Freitag.'],
    ['Telefonanlage', 'Die neue Telefonanlage wird am Dienstag umgestellt, die Durchwahlen bleiben gleich.'],
    ['Praktikum', 'Die Praktikantin beginnt am 1. September, bitte einen Arbeitsplatz vorbereiten.'],
    ['Mietwagen', 'Für die Messe in Leipzig habe ich zwei Mietwagen reserviert, Abholung am Hauptbahnhof.'],
    [
        'Webinar',
        'Das Webinar zur neuen Reisekostenabrechnung wird aufgezeichnet und anschließend verschickt.',
    ],
    ['Spendenaktion', 'Wir sammeln Winterjacken für die Kleiderkammer, die Kiste steht im Foyer.'],
    ['Arztbesuch', 'Ich komme morgen eine Stunde später, Arzttermin.'],
    ['Wasserspender', 'Der Wasserspender im Flur wird morgen gewartet und ist kurz nicht nutzbar.'],
    ['Betriebsfest', 'Das Sommerfest findet am 28. Juni im Garten statt, Familie ist willkommen.'],
    ['Dokumentenvorlage', 'Die neue Briefvorlage mit dem aktualisierten Logo liegt im Vorlagenordner.'],
    [
        'Zeiterfassung',
        'Bitte tragt eure Stunden bis Freitag in die Zeiterfassung ein, sonst verzögert sich die Abrechnung.',
    ],
    ['Fundsache', 'Eine schwarze Jacke hängt seit Montag in der Garderobe, wem gehört sie?'],
    ['Heizung', 'Die Heizung im dritten Stock wird gewartet, bitte eventuell einen Pullover mitbringen.'],
    [
        'Bewerbungsgespräch',
        'Das Gespräch mit dem Kandidaten für die Buchhaltung findet am Mittwoch um 9 Uhr statt.',
    ],
    [
        'Zugangskarte',
        'Die neue Zugangskarte kann ab Montag am Empfang abgeholt werden, die alte bitte abgeben.',
    ],
    ['Monatsbericht', 'Der Monatsbericht für September ist fertig und liegt im Laufwerk unter Berichte.'],
    ['Rückruf', 'Herr Beispiel hat angerufen und bittet um Rückruf, es geht um die Terminverschiebung.'],
    [
        'Fotoshooting',
        'Das Fotoshooting für die Webseite ist für Dienstagvormittag geplant, bitte ordentlich kleiden.',
    ],
    ['Geräteausgabe', 'Die neuen Headsets werden am Montag in der IT ausgegeben, bitte Ausweis mitbringen.'],
    ['Vertretung Empfang', 'Frau Lange vertritt diese Woche den Empfang, Besucher bitte bei ihr anmelden.'],
    ['lunch', 'Anyone up for sushi at noon? The new place around the corner has a lunch deal.'],
    ['holiday cover', 'I am out next week; Tom will cover my tickets and has access to the shared inbox.'],
    ['meeting moved', 'The Tuesday sync is moved to Wednesday 10:30 because of the client call.'],
    ['new printer', 'The new printer on floor two needs a driver, instructions are on the wiki.'],
    [
        'fire drill',
        'There will be a fire drill on Thursday morning, please follow the signs to the courtyard.',
    ],
    ['birthday cake', 'There is cake in the kitchen for Maria, help yourself before it is gone.'],
    ['wifi', 'The guest wifi is down, IT is looking into it and expects it to be back this afternoon.'],
    ['expenses reminder', 'Reminder: expense reports for the last quarter are due on the 5th.'],
    [
        'office plants',
        'Facilities will water the plants on Fridays, please do not overwater them in between.',
    ],
    ['bike shed', 'The bike shed lock has been changed, ask reception for the new code.'],
    ['training', 'The onboarding training for new starters takes place on Monday at 9 in the main hall.'],
    ['conference room', 'Conference room B is booked all day Thursday for the client workshop.'],
    ['slides', 'Here are the slides from yesterday, I added the notes on page 7.'],
    ['standup', 'Daily standup is at 9:15 from now on, same link as before.'],
    ['visitor badge', 'Visitors need to sign in at reception and wear their badge visibly at all times.'],
    [
        'catering order',
        'I placed the order for the breakfast on Friday: coffee, pastries and fruit for twenty.',
    ],
    [
        'parking',
        'Visitor parking is full on Tuesday because of the trade fair, please use the garage on Elm Street.',
    ],
    ['newsletter', 'The August newsletter is out. Contributions for September are welcome until the 20th.'],
    ['IT maintenance', 'The mail server is restarted on Sunday at 6 am, expect a short interruption.'],
    ['thank you', 'Thanks for covering my shift last week, I owe you a coffee.'],
    ['room booking', 'I booked the small meeting room for 3 pm to go through the roadmap.'],
    [
        'holiday calendar',
        'Please enter your holidays for next year in the shared calendar before the end of the month.',
    ],
    ['Re: draft', 'Looks good to me, just fix the typo in the second paragraph and send it.'],
    ['phone number', 'My new mobile number is on the staff list; the old one stops working on Friday.'],
    ['move', 'The marketing team moves to the third floor over the weekend, boxes are in the hallway.'],
    ['coffee beans', 'We are out of coffee beans, procurement has ordered two kilos which arrive Tuesday.'],
    ['screen sharing', 'For the call please use the new conference tool, a short guide is attached.'],
    ['Q3 goals', 'Here is the draft of the Q3 goals for the team, comments are welcome until Friday.'],
    ['farewell', 'Jonas leaves at the end of the month, we are collecting for a farewell present.'],
    ['train strike', 'Because of the train strike some of us will work from home, meetings are via video.'],
    [
        'Reisekostenabrechnung',
        'Die Reisekostenabrechnung für den Termin in München ist eingereicht, Belege sind angehängt.',
    ],
    [
        'Stellenausschreibung',
        'Die Stelle im Vertrieb ist ausgeschrieben, bitte Empfehlungen an die Personalabteilung weiterleiten.',
    ],
    [
        'Sitzungskalender',
        'Der Sitzungskalender für das nächste Halbjahr liegt im Gremienordner, bitte Termine übernehmen.',
    ],
    ['Druckauftrag', 'Der Druck der Broschüren verzögert sich um zwei Tage wegen eines Maschinenschadens.'],
    [
        'Rahmenvertrag Büromöbel',
        'Der Rahmenvertrag für Büromöbel wurde nach Ausschreibung an den günstigsten Anbieter vergeben.',
    ],
    ['Gesundheitstag', 'Der Gesundheitstag bietet Rückenmassage, Sehtest und eine Ernährungsberatung an.'],
    ['Quartalszahlen', 'Die Quartalszahlen liegen im üblichen Rahmen, die Details besprechen wir am Montag.'],
    ['Messestand', 'Der Messestand wird am Dienstag aufgebaut, bitte Flyer und Rollups ins Auto laden.'],
];

const extras = [...extraDe, ...extraEn, ...extraCross];

/** The mails that answer the queries: the original twelve plus one per grown pair. */
export const mails = [...baseMails, ...extras.map(({ id, subject, body }) => ({ id, subject, body }))];

/** Plausible mail that answers none of the queries; `hardFor` names the target a hard one is close to. */
export const distractors = [
    ...baseDistractors,
    ...hardDistractors.map(({ for: hardFor, subject, body }) => ({ subject, body, hardFor })),
    ...fillerDistractors.map(([subject, body]) => ({ subject, body })),
];

/**
 * Query → id of the one mail it should find. `lang` is query→mail, so `de→en` crosses over. `tag` is
 * `lexical` (the query shares keywords — FTS5 territory), `hard` (a hard distractor sits next to the
 * target) or `semantic` (the plain case).
 */
export const pairs = [
    ...basePairs.map((pair) => ({ ...pair, tag: 'semantic' })),
    ...extras.map(({ id, query, lang, lexical, hard }) => ({
        query,
        expect: id,
        lang,
        tag: lexical ? 'lexical' : hard ? 'hard' : 'semantic',
    })),
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
