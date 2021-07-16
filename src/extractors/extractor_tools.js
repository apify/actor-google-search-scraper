const cheerio = require("cheerio");

exports.extractPeopleAlsoAsk = ($) => {
    const peopleAlsoAsk = [];

    // HTML that we need is hidden in escaped script texts
    const scriptMatches = $('html').html().match(/,\'\\x3cdiv class\\x3d[\s\S]+?\'\)\;\}\)/gi);

    if (Array.isArray(scriptMatches)) {
        const htmls = scriptMatches.map((match) => {
            const escapedHtml = match.replace(',\'', '').replace('\');})', '');
            const unescaped = escapedHtml.replace(/\\x([a-f0-9]{2})/g, (match, group) => {
                const charCode = parseInt(group, 16);
                return String.fromCharCode(charCode);
            });
            return unescaped;
        });

        let answerIndex = -1;

        htmls.forEach((html, i) => {
            const $Internal = cheerio.load(html);

            // There are might be one extra post that is not really a question
            if ($Internal('[data-md]').length === 0) {
                return;
            }
            // count each answer
            answerIndex += 1;

            // some answers are split into two contiguous divs
            const $nextDiv = (htmls[i + 1] && cheerio.load(htmls[i + 1])?.('.g')) ?? null;

            // String separation of date from text seems more plausible than all the selector variants
            const date = $Internal('.Od5Jsd, .kX21rb, .xzrguc').text().trim();
            const fullAnswer = $Internal('[data-md]').text().trim();
            const dateMatch = fullAnswer.match(new RegExp(`(.+)${date}$`));
            const answer = dateMatch
                ? dateMatch[1]
                : fullAnswer;

            // Sometimes the question is not in the text but only in the href
            let questionParsedFromHref;
            const questionHref = $Internal('a[href^="/url"]').first().attr('href');
            if (questionHref) {
                const hrefMatch = new URL(questionHref, 'https://www.google.com');
                if (hrefMatch.searchParams.get('q')) {
                    questionParsedFromHref = hrefMatch.searchParams.get('q').replace(/\+/g, ' ');
                }
            }

            // Can be 'More results'
            const questionText = $Internal('a').last().text().trim();

            const result = {
                question:
                    // get the question from the main page by index
                    $('#rso g-accordion-expander span ~ div').eq(answerIndex).text().trim()
                    || questionParsedFromHref
                    || questionText,
                answer,
                url: $nextDiv?.find('a').first().attr('href')
                    || $Internal('a[href]:not([href^="https://www.google"])').first().attr('href')
                    || null,
                title: $nextDiv?.find('h3').first().text().trim() ?? $Internal('a.sXtWJb, h3').text().trim(),
                date,
            };
            peopleAlsoAsk.push(result);
        });
    }

    return peopleAlsoAsk;

    // Old parser - works in browser, keeping for a future reference if needed
    /*
    const date = $('.Od5Jsd, .kX21rb').text().trim();
    const fullAnswer = $('.mod').text().trim();
    const dateMatch = fullAnswer.match(new RegExp(`(.+)${date}$`));
    const answer = dateMatch
        ? dateMatch[1]
        : fullAnswer;
    const result = {
        question: $('div').eq(0).text().trim(),
        answer,
        url: $('a').attr('href'),
        title: isMobile ? $('a.sXtWJb').text().trim() : $('a h3').text().trim(),
        date,
    };
    */
};
