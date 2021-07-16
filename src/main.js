const Apify = require('apify');
const url = require('url');
const {
    REQUIRED_PROXY_GROUP, GOOGLE_DEFAULT_RESULTS_PER_PAGE, DEFAULT_GOOGLE_SEARCH_DOMAIN_COUNTRY_CODE,
    GOOGLE_SEARCH_DOMAIN_TO_COUNTRY_CODE, GOOGLE_SEARCH_URL_REGEX } = require('./consts');
const extractorsDesktop = require('./extractors/desktop');
const extractorsMobile = require('./extractors/mobile');
const {
    getInitialRequests, executeCustomDataFunction, getInfoStringFromResults, createSerpRequest,
    logAsciiArt, createDebugInfo, ensureAccessToSerpProxy,
} = require('./tools');

const { log } = Apify.utils;

Apify.main(async () => {
    const input = await Apify.getInput();

    const {
        maxConcurrency,
        maxPagesPerQuery,
        customDataFunction,
        mobileResults,
        saveHtml,
        saveHtmlToKeyValueStore,
    } = input;

    // Check that user have access to SERP proxy.
    await ensureAccessToSerpProxy();
    logAsciiArt();

    const proxyConfiguration = await Apify.createProxyConfiguration({
        groups: [REQUIRED_PROXY_GROUP],
    });

    // Create initial request list and queue.
    const initialRequests = getInitialRequests(input);
    if (!initialRequests.length) throw new Error('The input must contain at least one search query or URL.');
    const requestList = await Apify.openRequestList('initial-requests', initialRequests);
    const requestQueue = await Apify.openRequestQueue();
    const dataset = await Apify.openDataset();
    const keyValueStore = await Apify.openKeyValueStore();
    const extractors = mobileResults ? extractorsMobile : extractorsDesktop;

    // Create crawler.
    const crawler = new Apify.CheerioCrawler({
        requestList,
        requestQueue,
        proxyConfiguration,
        maxConcurrency,
        preNavigationHooks: [async ({ request }) => {
            const parsedUrl = url.parse(request.url, true);
            request.userData.startedAt = new Date();
            log.info(`Querying "${parsedUrl.query.q}" page ${request.userData.page} ...`);
        }],
        handlePageTimeoutSecs: 40,
        requestTimeoutSecs: 50,
        handlePageFunction: async ({ request, response, body, $ }) => {
            if ($('#recaptcha').length) {
                throw new Error('Captcha found, retrying...');
            }

            request.userData.finishedAt = new Date();

            const nonzeroPage = request.userData.page + 1; // Display same page numbers as Google, i.e. 1, 2, 3..
            const parsedUrl = url.parse(request.url, true);

            // We know the URL matches (otherwise we have a bug here)
            const matches = GOOGLE_SEARCH_URL_REGEX.exec(request.url);
            const domain = matches[3].toLowerCase();
            const resultsPerPage = parsedUrl.query.num || GOOGLE_DEFAULT_RESULTS_PER_PAGE;
            const { host } = parsedUrl;

            // Compose the dataset item.
            const data = {
                '#debug': createDebugInfo(request, response),
                '#error': false,
                searchQuery: {
                    term: parsedUrl.query.q,
                    device: mobileResults ? 'MOBILE' : 'DESKTOP',
                    page: nonzeroPage,
                    type: 'SEARCH',
                    domain,
                    countryCode: GOOGLE_SEARCH_DOMAIN_TO_COUNTRY_CODE[domain] || DEFAULT_GOOGLE_SEARCH_DOMAIN_COUNTRY_CODE,
                    languageCode: parsedUrl.query.hl || null,
                    locationUule: parsedUrl.query.uule || null,
                    resultsPerPage,
                },
                url: request.url,
                hasNextPage: false,
                resultsTotal: extractors.extractTotalResults($),
                relatedQueries: extractors.extractRelatedQueries($, host),
                paidResults: extractors.extractPaidResults($),
                paidProducts: extractors.extractPaidProducts($),
                organicResults: extractors.extractOrganicResults($, host),
                peopleAlsoAsk: extractors.extractPeopleAlsoAsk($),
                customData: customDataFunction
                    ? await executeCustomDataFunction(customDataFunction, { input, $, request, response, html: body, Apify })
                    : null,
            };

            if (saveHtml) data.html = body;

            if (saveHtmlToKeyValueStore) {
                const key = `${request.id}.html`;
                await keyValueStore.setValue(key, body, { contentType: 'text/html; charset=utf-8' });
                data.htmlSnapshotUrl = keyValueStore.getPublicUrl(key);
            }

            const searchOffset = nonzeroPage * resultsPerPage;

            // Enqueue new page. Universal "next page" selector
            const nextPageUrl = $(`a[href*="start=${searchOffset}"]`).attr('href');

            if (nextPageUrl) {
                data.hasNextPage = true;
                if (request.userData.page < maxPagesPerQuery - 1 && maxPagesPerQuery) {
                    const nextPageHref = url.format({
                        ...parsedUrl,
                        search: undefined,
                        query: {
                            ...parsedUrl.query,
                            start: `${searchOffset}`,
                        },
                    });
                    await requestQueue.addRequest(createSerpRequest(nextPageHref, request.userData.page + 1));
                } else {
                    log.info(`Not enqueueing next page for query "${parsedUrl.query.q}" because the "maxPagesPerQuery" limit has been reached.`);
                }
            } else {
                log.info(`This is the last page for query "${parsedUrl.query.q}". Next page button has not been found.`);
            }

            await dataset.pushData(data);

            // Log some nice info for user.
            log.info(`Finished query "${parsedUrl.query.q}" page ${nonzeroPage} (${getInfoStringFromResults(data)})`);
        },
        handleFailedRequestFunction: async ({ request }) => {
            await dataset.pushData({
                '#debug': createDebugInfo(request),
                '#error': true,
            });
        },
    });

    // Run the crawler.
    await crawler.run();

    const { datasetId } = dataset;
    if (datasetId) {
        log.info(`Scraping is finished, see you next time.

Full results in JSON format:
https://api.apify.com/v2/datasets/${datasetId}/items?format=json

Simplified organic results in JSON format:
https://api.apify.com/v2/datasets/${datasetId}/items?format=json&fields=searchQuery,organicResults&unwind=organicResults`);
    } else {
        log.info('Scraping is finished, see you next time.');
    }
});
