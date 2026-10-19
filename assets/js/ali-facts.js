/* Facts about Ali that the chat may need but the page does not state in one place.
   The chat finds them the same way it finds page text (gemma-rag.js), so keep each one a short, true sentence.
   `always: true` puts a fact in front of every answer, so keep that one very short.
   `needs` (a regular expression) keeps a fact out of answers to questions that do not match it. */
window.ALI_FACTS = [
  { title: 'Who Ali is', always: true, section: 'about',
    text: 'Ali Haider is a Ph.D. researcher in artificial intelligence at Kyung Hee University in South Korea ' +
          '(MLVC Lab, advisor Professor Sung Ho Bae). He is from Pakistan and is not Korean. His native language is Urdu.' },

  { title: 'Nationality and origin', section: 'about',
    text: 'Ali Haider\'s nationality, country and origin: Pakistan. He is Pakistani, not Korean. He earned his B.Sc. in ' +
          'Electronics Engineering at UET Taxila and worked as a Research Assistant at CISS-Global, ITU Lahore, in Pakistan. ' +
          'He now studies in South Korea.' },

  { title: 'Education and work history', section: 'about',
    text: 'Ali Haider\'s education and work history: B.Sc. in Electronics Engineering at UET Taxila, Pakistan; Research ' +
          'Assistant at CISS-Global, ITU Lahore, from 2019; an internship at NIE Islamabad; algorithm lead at the startup ' +
          'Due Dilly (acquired by Beckett Media); Ph.D. student in the MLVC Lab at Kyung Hee University, South Korea, ' +
          'from 2022.' },

  { title: 'Why Korea appears on this site', section: 'about', needs: 'korea|korean|seoul|why|nationalit|origin|pakistan|citizen',
    text: 'The site mentions Korea because Ali studies there: Kyung Hee University, a patent with the Korean Intellectual ' +
          'Property Office, a paper at a Korean conference (KMBE) and ICML 2026 in Seoul. That describes where he studies ' +
          'and works, not his nationality.' }
];
