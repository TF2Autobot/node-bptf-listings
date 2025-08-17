const async = require('async');
const SteamID = require('steamid');
const _axios = require('axios').default;
const SKU = require('@tf2autobot/tf2-sku');
const filterAxiosError = require('@tf2autobot/filter-axios-error');

const inherits = require('util').inherits;
const EventEmitter = require('events').EventEmitter;

const Listing = require('./classes/listing');

const EFailiureReason = require('./resources/EFailureReason');

// TODO: UPGRADE TO TYPESCRIPT
// TODO: BETTER REQUEST/RATE-LIMIT HANDLING (WITH QUEUE)
// TODO: UPGRADE EVERYTHING TO V2
// THINGS THAT STILL USE V1: /classifieds/listings/v1 AND /classifieds/delete/v1

const attempts = {};

// Track rate-limit windows per endpoint path to avoid globally blocking unrelated API calls
// Keyed by options.url that we pass to axios (e.g. '/v2/classifieds/listings/batch')
const rateLimitUntilByPath = {};

async function axios(options) {
    // If this specific path is currently rate-limited, short-circuit to allow the caller
    // to back off without blocking other endpoints.
    const limiterKey = options.url;
    if (rateLimitUntilByPath[limiterKey] && Date.now() < rateLimitUntilByPath[limiterKey]) {
        const remainingMs = Math.max(0, rateLimitUntilByPath[limiterKey] - Date.now());
        const err = new Error('Rate limited, pausing sending requests to backpack.tf.');
        // Mimic minimal AxiosError shape so downstream handlers can process uniformly
        err.response = {
            status: 429,
            data: {
                message: `Rate limited, try again in ${Math.max(1, Math.round(remainingMs / 1000))} second`,
                retry_after_ms: remainingMs
            }
        };
        throw err;
    }

    const attemptType = `${options.method}_${options.url}`;
    if (attempts[attemptType] === undefined) {
        attempts[attemptType] = 0;
    }
    attempts[attemptType]++;

    await new Promise(r => setTimeout(() => r(), 1000));
    try {
        const res = await _axios(options);
        delete attempts[attemptType];
        return res;
    } catch (err) {
        if (err?.response?.status === 429) {
            // Too many request error
            if (attempts[attemptType] < 3) {
                // Retry a couple of times obeying server-provided retry-after semantics
                const headerRetryAfterSec = Number(err.response?.headers?.['retry-after']);
                const match = err.response?.data?.message?.match(/in (\d+) second/);
                const parsedMsgSec = match ? parseInt(match[1], 10) + 1 : NaN;

                // retry_after in API may arrive as milliseconds or seconds depending on endpoint
                const dataRetryAfter = err.response?.data?.retry_after;
                const dataRetryAfterMs = err.response?.data?.retry_after_ms;

                let sleepMs = 0;
                if (Number.isFinite(dataRetryAfterMs)) sleepMs = dataRetryAfterMs;
                else if (Number.isFinite(dataRetryAfter)) sleepMs = dataRetryAfter * 1000;
                else if (Number.isFinite(headerRetryAfterSec)) sleepMs = headerRetryAfterSec * 1000;
                else if (Number.isFinite(parsedMsgSec)) sleepMs = parsedMsgSec * 1000;
                else sleepMs = 61 * 1000; // conservative default

                // Record per-path rate-limit window
                rateLimitUntilByPath[limiterKey] = Date.now() + sleepMs;

                console.warn(`Rate limited for ${Math.round(sleepMs / 1000)} seconds for ${options.url}.`);
                console.warn(`Waiting ${Math.round(sleepMs / 1000)} s before retrying...`);
                await new Promise(r => setTimeout(r, sleepMs));

                return axios(options);
            }
            
        }
        delete attempts[attemptType];
        throw err;
    }
}

function exponentialBackoff(n, base = 1000) {
    return Math.pow(2, n) * base + Math.floor(Math.random() * base);
}

class ListingManager {
    /**
     * Creates a new instance of the listing manager
     * @param {Object} options
     * @param {String} options.token The access token of the account being managed
     * @param {String} options.steamid The steamid of the account being managed
     * @param {String} options.userAgent The User-Agent header to be sent to bptf
     * @param {String} options.userID The cookie we get from bptf-login
     * @param {Number} [options.waitTime=6000] Time to wait before processing the queues
     * @param {Number} [options.batchSize=100]
     * @param {Object} options.schema Schema from the tf2-schema module (schemaManager.schema)
     */
    constructor(options) {
        options = options || {};

        EventEmitter.call(this);

        this.token = options.token;
        this.steamid = new SteamID(options.steamid);
        this.userAgent = options.userAgent;
        this.userID = options.userID;

        // Time to wait before sending request after enqueing action
        // Set default to 6 seconds:
        // V2 api batch is rate limited to 10 req/minute.
        this.waitTime = options.waitTime || 6000;
        // Amount of listings to create at once
        this.batchSize = options.batchSize || 30;

        this.cap = null;
        this.promotes = null;

        this.listings = [];

        this.actions = {
            create: [],
            remove: [],
            update: []
        };

        this.isGettingListings = false;
        this.deleteArchivedFailedAttempt = {};

        this.schema = options.schema || null;

        this._lastInventoryUpdate = null;
        this._createdListingsCount = 0;
        this._listings = {};
        this._actions = {
            create: {},
            remove: {},
            update: {}
        };

        this._batchOpNext = 'update';

        this.archivedBatchSize = options.archivedBatchSize || 30;

        this.maxCreateRetry = options.maxCreateRetry || 3;
        // Default = 2 hours to for slow inventory refreshes
        this.waitForInventoryTimeoutMs = options.waitForInventoryTimeoutMs || 2 * 60 * 60 * 1000;
    }

    setUserID(userID) {
        this.userID = userID;
    }

    setRequestOptions(method, url, body) {
        const options = {
            baseURL: 'https://api.backpack.tf/api',
            url: url,
            method,
            headers: {
                'User-Agent': this.userAgent ? this.userAgent : 'User Agent',
                Cookie: 'user-id=' + this.userID
            },
            params: {
                token: this.token
            }
        };

        if (body) {
            if (method === 'GET') {
                options.params = Object.assign({}, options.params, body);
            } else {
                options['data'] = body;
            }
        }

        return options;
    }

    /**
     * Initializes the module
     * @param {Function} callback
     */
    init(callback) {
        if (this.ready) {
            callback(null);
            return;
        }

        if (!this.steamid.isValid()) {
            callback(new Error('Invalid / missing steamid64'));
            return;
        }

        if (this.schema === null) {
            callback(new Error('Missing schema from tf2-schema'));
            return;
        }

        this.registerUserAgent(err => {
            if (err) {
                return callback(err);
            }

            this.getBatchOpLimit(err => {
                if (err) {
                    return callback(err);
                }

                this._updateInventory(() => {
                    this._startTimers();

                    this.ready = true;
                    this.emit('ready');

                    this.emit('listings', this.listings);

                    this._processActions();

                    return callback(null);
                });
            });
        });
    }

    /**
     * (Re)-register user-agent to backpack.tf.
     * @description Bumps listings and gives you lightning icon on listings if you have set a tradeofferurl in your settings (https://backpack.tf/settings)
     * @param {Function} callback
     */
    registerUserAgent(callback) {
        if (!this.token) {
            callback(new Error('No token set (yet)'));
            return;
        }

        const options = this.setRequestOptions('POST', '/agent/pulse');

        axios(options)
            .then(response => {
                const body = response.data;

                this.emit('pulse', {
                    status: body.status,
                    current_time: body.current_time,
                    expire_at: body.expire_at,
                    client: body.client
                });

                return callback(null, body);
            })
            .catch(err => {
                if (err) {
                    return callback(err);
                }
            });
    }

    /**
     * Unregister user-agent to backpack.tf.
     * @description Prematurely declare the user as no longer being under control of the user agent. Should be used as part of a clean shutdown.
     * @param {Function} callback
     */
    stopUserAgent(callback) {
        if (!this.token) {
            callback(new Error('No token set (yet)'));
            return;
        }

        const options = this.setRequestOptions('POST', '/agent/stop');

        axios(options)
            .then(response => {
                const body = response.data;

                this.emit('pulse', { status: body.status });

                return callback(null, body);
            })
            .catch(err => {
                if (err) {
                    return callback(err);
                }
            });
    }

    /**
     * Get the batch operation limit
     * @param {Function} callback
     */
    getBatchOpLimit(callback) {
        if (!this.token) {
            callback(new Error('No token set (yet)'));
            return;
        }

        const options = this.setRequestOptions('GET', '/v2/classifieds/listings/batch');
        const optionsArchive = this.setRequestOptions('GET', '/v2/classifieds/archive/batch');

        axios(options)
            .then(response => {
                const body = response.data;
                if (Number.isFinite(body?.opLimit)) {
                    this.batchSize = body.opLimit;
                    this.emit('batchLimit', body.opLimit);
                }
                return axios(optionsArchive)
                    .then(response2 => {
                        const body2 = response2.data;
                        if (Number.isFinite(body2?.opLimit)) {
                            this.archivedBatchSize = body2.opLimit;
                            this.emit('archiveBatchLimit', body2.opLimit);
                        }
                        return callback(null, { listings: body, archive: body2 });
                    })
                    .catch(err2 => {
                        // If archive/batch is not available (404) or bad request, keep default archivedBatchSize
                        if (err2?.response?.status === 404 || err2?.response?.status === 400) {
                            return callback(null, { listings: body, archive: null });
                        }
                        return callback(err2);
                    });
            })
            .catch(err => {
                if (err) {
                    return callback(err);
                }
            });
    }

    /**
     * Updates your inventory on backpack.tf
     * @param {Function} callback
     */
    _updateInventory(callback) {
        const options = this.setRequestOptions('POST', `/inventory/${this.steamid.getSteamID64()}/refresh`);

        axios(options)
            .then(response => {
                const body = response.data;

                if (response.status >= 400) {
                    return callback(new Error(response.status + ' (' + response.statusText + ')'));
                }

                const time = body.last_update;

                if (this._lastInventoryUpdate === null) {
                    this._lastInventoryUpdate = time;
                } else if (time !== this._lastInventoryUpdate) {
                    this._lastInventoryUpdate = time;

                    this.emit('inventory', this._lastInventoryUpdate);

                    this._processActions();
                }

                return callback(null);
            })
            .catch(err => {
                if (err) {
                    return callback(err);
                }
            });
    }

    /**
     * Gets the listings that you have on backpack.tf
     * @param {Boolean} onShutdown
     * @param {Function} callback
     */
    getListings(onShutdown, callback) {
        if (!this.token) {
            callback(new Error('No token set (yet)'));
            return;
        }

        // We will still use v1 for active listings

        const options = this.setRequestOptions('GET', '/classifieds/listings/v1', {
            automatic: 'all'
        });

        this.isGettingListings = true;

        axios(options)
            .then(response => {
                const body = response.data;

                this.cap = body.cap;
                this.promotes = body.promotes_remaining;
                this.listings = body.listings.filter(raw => raw.appid === 440).map(raw => new Listing(raw, this, false));

                const populate = () => {
                    // Populate map
                    this._listings = {};
                    this.listings.forEach(listing => {
                        this._listings[listing.intent == 0 ? listing.getSKU() : listing.item.id] = listing;
                    });

                    this._createdListingsCount = 0;

                    // Go through create queue and find listings that need retrying
                    this.actions.create.forEach(formatted => {
                        if (formatted.retry !== undefined) {
                            // Look for a listing that has a matching sku / id
                            const match = this.findListing(formatted.intent === 0 ? formatted.sku : formatted.id);
                            if (match !== null && match.archived === false) {
                                // Found match, remove the listing and unset retry property
                                match.remove();
                            }
                        }
                    });

                    if (this.ready) {
                        this.emit('listings', this.listings);
                    }

                    this.isGettingListings = false;
                    callback(null, body);
                };

                if (onShutdown) {
                    return populate();
                }

                getAllArchivedListings(
                    0,
                    {
                        'User-Agent': this.userAgent ? this.userAgent : 'User Agent',
                        Cookie: 'user-id=' + this.userID
                    },
                    this.token,
                    [],
                    (err, archivedListings) => {
                        if (err) {
                            this.isGettingListings = false;
                            return callback(err);
                        }

                        this.listings = this.listings.concat(archivedListings.map(raw => new Listing(raw, this, true)));

                        return populate();
                    }
                );
            })
            .catch(err => {
                if (err) {
                    this.isGettingListings = false;
                    return callback(err);
                }
            });
    }

    /**
     * Searches for one specific listing by sku or assetid
     * @param {String|Number} search
     * @return {Listing} Returns matching listing
     */
    findListing(search) {
        return this._listings[search] === undefined ? null : this._listings[search];
    }

    /**
     * Finds all listings that match the sku of the item
     * @param {String} sku
     * @return {Array<Listing>} Returns matching listings
     */
    findListings(sku) {
        return this.listings.filter(listing => {
            return listing.getSKU() === sku;
        });
    }

    /**
     * Enqueues a list of listings to be made
     * @param {Array<Object>} listings
     */
    createListings(listings) {
        if (!this.ready) {
            throw new Error('Module has not been successfully initialized');
        }

        const formattedArr = listings.map(value => this._formatListing(value)).filter(formatted => formatted !== null);

        const remove = [];

        formattedArr.forEach(formatted => {
            const match = this.findListing(formatted.intent === 0 ? formatted.sku : formatted.id);
            if (match !== null) {
                remove.push(match.id);
            }
        });

        this._action('remove', remove);
        this._action('create', formattedArr);
    }

    /**
     * Enqueues a list of listings to be made
     * @param {Object} listing
     */
    createListing(listing) {
        if (!this.ready) {
            throw new Error('Module has not been successfully initialized');
        }

        const formatted = this._formatListing(listing);

        if (formatted !== null) {
            const match = this.findListing(formatted.intent === 0 ? formatted.sku : formatted.id);
            if (match !== null && match.archived === false) {
                match.remove();
            }

            this._action('create', formatted);
        }
    }

    /**
     * Enqueues a list of listings to be made
     * @param {String} listing listing object
     * @param {Object} properties properties
     */
    updateListing(listing, properties) {
        if (!this.ready) {
            throw new Error('Module has not been successfully initialized');
        }

        if (listing.archived) {
            // if archived, we recreate it.
            const toRecreate = Object.assign(
                {},
                {
                    time: listing.time || Math.floor(new Date().getTime() / 1000),
                    sku: listing.sku,
                    intent: listing.intent,
                    currencies: listing.currencies,
                    details: listing.details
                }
            );

            for (const key in properties) {
                if (!properties.hasOwnProperty(key)) {
                    continue;
                }

                toRecreate[key] = properties[key];
            }

            const formatted = this._formatListing(toRecreate);

            if (formatted !== null) {
                this._action('create', formatted);
            }
        } else {
            const formatted = { id: listing.id, body: properties };

            this._action('update', formatted);
        }
    }

    /**
     * Enqueus a list of listings or listing ids to be removed
     * @param {Array<Object>|Array<String>} listings
     */
    removeListings(listings) {
        if (!this.ready) {
            throw new Error('Module has not been successfully initialized');
        }

        const formatted = listings.map(value => (!isObject(value) ? value : value.id));

        this._action('remove', formatted);
    }

    /**
     * Enqueus a list of listings or listing ids to be removed
     * @param {Object|String} listing
     */
    removeListing(listing) {
        if (!this.ready) {
            throw new Error('Module has not been successfully initialized');
        }

        if (this.actions.create.length > 0) {
            // remove from create queue
            const sku = listing.getSKU();
            const id = listing.id.replace('440_', ''); // we don't use for buy order
            this.actions.create = this.actions.create.filter(formatted => {
                return listing.intent === 0 ? sku !== formatted.sku : id !== formatted.id;
            });
        }

        // We will also call this no matter what because sometimes the listings that were archived
        // earlier become active when there's enough pure, but in memory, it's still "archived",
        // so it is not being removed.
        this._action('remove', listing.id);
    }

    /**
     * Function used to enqueue jobs
     * @param {String} type
     * @param {Array<Object>|Array<String>|Object|String} value
     */
    _action(type, value) {
        const array = Array.isArray(value) ? value : [value];

        if (array.length === 0) {
            return;
        }

        let doneSomething = false;

        if (type === 'remove') {
            const noMatch = array.filter(id => this.actions.remove.indexOf(id) === -1);
            if (noMatch.length !== 0) {
                this.actions[type] = this.actions[type].concat(noMatch);
                doneSomething = true;
            }
        } else if (type === 'create') {
            // Find listings that we should make
            const newest = array.filter(formatted => this._isNewest(formatted));

            // Find listings that has old listings
            const hasOld = newest.filter(formatted => this._hasOld(formatted));

            // Set new
            newest.forEach(formatted => this._setNew(formatted));

            hasOld.forEach(formatted => this._removeEnqueued(formatted));

            if (newest.length !== 0) {
                this.actions[type] = this.actions[type].concat(newest);
                doneSomething = true;
            }
        } else if (type === 'update') {
            this.actions[type] = this.actions[type].concat(array);
            doneSomething = true;
        }

        if (doneSomething) {
            this.emit('actions', this.actions);

            this._processActions();
        }
    }

    _setNew(formatted) {
        const identifier = formatted.intent == 0 ? formatted.sku : formatted.id;

        if (this._actions.create[identifier] === undefined || this._actions.create[identifier].time < formatted.time) {
            this._actions.create[identifier] = formatted;
        }
    }

    _hasOld(formatted) {
        const identifier = formatted.intent == 0 ? formatted.sku : formatted.id;

        if (this._actions.create[identifier] === undefined) {
            return false;
        }

        return this._actions.create[identifier].time < formatted.time;
    }

    _isNewest(formatted) {
        const identifier = formatted.intent == 0 ? formatted.sku : formatted.id;

        if (this._actions.create[identifier] === undefined) {
            return true;
        }

        if (this._actions.create[identifier].time < formatted.time) {
            // This listing is newer that the old one
            return true;
        }

        return false;
    }

    /**
     * Starts user-agent and inventory timers
     */
    _startTimers() {
        this._updateListingsInterval = setInterval(
            ListingManager.prototype._updateListings.bind(this, () => {}),
            90000
        );
        this._userAgentInterval = setInterval(
            ListingManager.prototype._renewUserAgent.bind(this, () => {}),
            360000 // 6 minutes
        );
        this._inventoryInterval = setInterval(
            ListingManager.prototype._updateInventory.bind(this, () => {}),
            180000 // 3 minutes
        );
        this._getBatchOpLimitInterval = setInterval(
            ListingManager.prototype.getBatchOpLimit.bind(this, () => {}),
            60000
        );
        this._checkArchivedListingsFailedToDeleteInterval = setInterval(
            () => {
                const listingIds = Object.keys(this.deleteArchivedFailedAttempt);
                if (listingIds.length > 0) {
                    this._deleteArchived(listingIds[0]);
                }
            },
            15000 // Every 15 seconds (archived, so no problem)
        );
    }

    /**
     * Stops all timers and timeouts and clear values to default
     */
    shutdown() {
        clearTimeout(this._timeout);
        clearInterval(this._updateListingsInterval);
        clearInterval(this._userAgentInterval);
        clearInterval(this._inventoryInterval);
        clearInterval(this._getBatchOpLimitInterval);
        clearInterval(this._checkArchivedListingsFailedToDeleteInterval);

        this.stopUserAgent(() => {
            this.ready = false;
            this.listings = [];
            this.cap = null;
            this.promotes = null;
            this.actions = { create: [], remove: [], update: [] };
            this._actions = { create: {}, remove: {}, update: {} };
            this.deleteArchivedFailedAttempt = {};
            this._checkArchivedListingsFailedToDeleteInterval = null;
            this._lastInventoryUpdate = null;
            this._createdListingsCount = 0;
        });
    }

    /**
     * Renew user-agent
     * @param {Function} callback
     */
    _renewUserAgent(callback) {
        async.series(
            [
                callback => {
                    this.registerUserAgent(callback);
                }
            ],
            err => {
                return callback(err);
            }
        );
    }

    /**
     * Gets listings
     * @param {Function} callback
     */
    _updateListings(callback) {
        async.series(
            [
                callback => {
                    this.getListings(false, callback);
                }
            ],
            err => {
                return callback(err);
            }
        );
    }

    /**
     * Processes action queues
     * @param {Function} [callback]
     */
    _processActions(callback) {
        if (callback === undefined) {
            callback = noop;
        }

        if (this._processingActions || this.isGettingListings) {
            callback(null);
            return;
        }

        // Remove stale create entries to avoid being stuck forever
        this._pruneStaleCreateQueue();

        this._processingActions = true;

        setTimeout(
            () => {
                const tasks = [];

                // Always try to process deletions first
                if (this.actions.remove.length > 0) {
                    tasks.push(callback => this._delete(callback));
                }

                const haveUpdate = this.actions.update.length > 0;
                const haveCreate = this.actions.create.some(l => !this._isCreateWaiting(l));

                if (haveUpdate || haveCreate) {
                    if (this._batchOpNext === 'update') {
                        if (haveUpdate) {
                            tasks.push(callback => this._update(callback));
                            this._batchOpNext = 'create';
                        } else if (haveCreate) {
                            tasks.push(callback => this._create(callback));
                            // Keep next desired op as 'update' for fairness
                            this._batchOpNext = 'update';
                        }
                    } else {
                        if (haveCreate) {
                            tasks.push(callback => this._create(callback));
                            this._batchOpNext = 'update';
                        } else if (haveUpdate) {
                            tasks.push(callback => this._update(callback));
                            this._batchOpNext = 'create';
                        }
                    }
                }

                if (tasks.length === 0) {
                    this._processingActions = false;
                    return callback(null);
                }

                async.series(
                    tasks,
                    (err, result) => {
                        // TODO: Only get listings if we created or deleted listings

                        if (err?.response?.status === 429) {
                            // Too many request error or pre-check short-circuit
                            const message = err.response?.data?.message || '';
                            const match = message.match(/in (\d+) second/);
                            const parsedMsgMs = match ? (parseInt(match[1], 10) + 1) * 1000 : null;
                            const retryAfterMs = Number.isFinite(err.response?.data?.retry_after_ms)
                                ? err.response.data.retry_after_ms
                                : (Number.isFinite(err.response?.data?.retry_after)
                                    ? err.response.data.retry_after * 1000
                                    : null);
                            this.sleepRateLimited = retryAfterMs ?? parsedMsgMs ?? 61 * 1000;
                            this.isRateLimited = true;

                            this._processingActions = false;
                            this._processActions();

                            return callback(null);
                        }

                        if (
                            this.actions.remove.length !== 0 ||
                            this.actions.update.length !== 0 ||
                            this._listingsWaitingForRetry() - this.actions.create.length !== 0
                        ) {
                            this._processingActions = false;
                            this._processActions();
                            callback(null);
                        } else {
                            this.getListings(false, () => {
                                this._processingActions = false;
                                callback(null);
                            });
                        }
                    }
                );
            },
            this.isRateLimited ? this.sleepRateLimited + this.waitTime : this.waitTime
        );

        if (this.isRateLimited) {
            this.isRateLimited = false;
            this.sleepRateLimited = null;
        }
    }

    /**
     * Creates a batch of listings from the queue
     * @param {Function} callback
     */
    _create(callback) {
        if (this.actions.create.length === 0) {
            callback(null, null);
            return;
        }

        // TODO: Don't send sku and attempt time to backpack.tf

        const batch = this.actions.create
            .filter(listing => !this._isCreateWaiting(listing))
            .slice(0, this.batchSize);

        if (batch.length === 0) {
            callback(null, null);
            return;
        }

        const options = this.setRequestOptions('POST', '/v2/classifieds/listings/batch', batch);

        axios(options)
            .then(response => {
                const body = response.data;

                const waitForInventory = [];
                const retryListings = [];

                if (Array.isArray(body)) {
                    let created = 0;
                    let archived = 0;
                    let errors = [];

                    body.forEach((element, index) => {
                        if (element.result) {
                            // There are "archived":true,"status":"notEnoughCurrency", might be good to do something about it
                            created++;
                            this._createdListingsCount++;

                            if (element.result.archived === true) {
                                archived++;
                            }
                        } else if (element.error) {
                            errors.push({ listing: batch[index], error: element.error });

                            const identifier = batch[index].intent === 0 ? batch[index].sku : batch[index].id;

                            if (element.error.message === '' || element.error.message.includes('timestamp')) {
                                waitForInventory.push(identifier);
                            } else if (element.error.message.includes('as it already exists')) {
                                // This error should be extremely rare

                                const match = this.actions.create.find(formatted =>
                                    this._isSameByIdentifier(formatted, formatted.intent, identifier)
                                );

                                if (match !== undefined) {
                                    // If we can't find the listing, then it was already removed / we can't identify the item / we can't properly list the item (FISK!!!)
                                    retryListings.push(match.intent === 0 ? identifier : match.id);
                                }
                            }
                        }

                        // element.error:
                        // error: {
                        //    message:
                        //    'Cannot relist listing (Non-Craftable Killstreak Batsaber Kit) as it already exists.'
                        // }
                    });

                    this.emit('createListingsSuccessful', { created, archived, errors });
                }

                this.actions.create = this.actions.create.filter(formatted => {
                    if (formatted.intent === 1 && waitForInventory.includes(formatted.id)) {
                        // We should wait for the inventory to update
                        formatted.attempt = this._lastInventoryUpdate;
                        if (formatted.waitSince === undefined) {
                            formatted.waitSince = Date.now();
                        }
                        return true;
                    }

                    if (
                        formatted.retry !== true &&
                        retryListings.includes(formatted.intent === 0 ? formatted.sku : formatted.id)
                    ) {
                        // A similar listing was already made, we will need to remove the old listing and then try and add this one again
                        formatted.retry = true;
                        formatted.retryCount = (formatted.retryCount || 0) + 1;
                        return true;
                    }

                    const index = batch.findIndex(v => this._isSame(formatted, v));

                    if (index !== -1) {
                        // Listing was created, remove it from the batch and from the actions map
                        delete this._actions.create[formatted.intent === 0 ? formatted.sku : formatted.id];
                        batch.splice(index, 1);
                    }

                    return index === -1;
                });

                this.emit('actions', this.actions);

                callback(null, body);
            })
            .catch(err => {
                if (err) {
                    this.emit('createListingsError', filterAxiosError(err));
                    return callback(err);
                }
            });
    }

    /**
     * Update all listings in the update queue
     * @param {Function} callback
     */
    _update(callback) {
        if (this.actions.update.length === 0) {
            callback(null, null);
            return;
        }

        const update =
            this.actions.update.length > this.batchSize
                ? this.actions.update.slice(0, this.batchSize)
                : this.actions.update;

        if (update.length === 0) {
            callback(null, null);
            return;
        }

        const options = this.setRequestOptions('PATCH', '/v2/classifieds/listings/batch', update);

        axios(options)
            .then(response => {
                const body = response.data;

                this.emit('updateListingsSuccessful', { updated: body.updated?.length, errors: body.errors });

                if (Array.isArray(body.errors) && body.errors.length > 0) {
                    // got some error
                    body.errors.forEach(error => {
                        // error<{ id: string, index: number, message: string }>
                        if (error.message === 'Item not found') {
                            // The listing might has been put into archived listing
                            const listingId = error.id;
                            const listingIndex = this.listings.findIndex(listing => listing.id === listingId);

                            if (listingIndex >= 0) {
                                const toRelist = this.listings[listingIndex];
                                const reCreateListing = {
                                    time: toRelist.time || Math.floor(new Date().getTime() / 1000),
                                    intent: toRelist.intent,
                                    details: toRelist.details,
                                    currencies: toRelist.currencies
                                };
                                if (toRelist.intent === 0) {
                                    reCreateListing['sku'] = toRelist.getSKU();
                                } else {
                                    reCreateListing['id'] = toRelist.item.id;
                                    reCreateListing['promoted'] = toRelist.promoted;
                                }

                                this.createListing(reCreateListing);

                                delete this._listings[toRelist.intent === 0 ? toRelist.getSKU() : toRelist.item.id];
                                this.listings.splice(listingIndex, 1);
                            }
                        }
                    });
                }

                update.forEach(el => {
                    const index = this.listings.findIndex(listing => listing.id === el.id);
                    if (index >= 0) {
                        for (const key in el.body) {
                            if (!Object.prototype.hasOwnProperty.call(this.listings[index], key)) return;
                            if (!Object.prototype.hasOwnProperty.call(el.body, key)) return;
                            this.listings[index][key] = el.body[key];
                        }
                        this._listings[
                            this.listings[index].intent === 0
                                ? this.listings[index].getSKU()
                                : this.listings[index].item.id
                        ] = this.listings[index];
                    }

                    this.actions.update.shift();
                });

                this.emit('actions', this.actions);

                return callback(null, body);
            })
            .catch(err => {
                if (err) {
                    this.emit('updateListingsError', filterAxiosError(err));
                    // Might need to do something if failed, like if item id not found.
                    return callback(err);
                }
            });
    }

    /**
     * Removes all listings in the remove queue
     * @param {Function} callback
     */
    _delete(callback) {
        if (this.actions.remove.length === 0) {
            callback(null, null);
            return;
        }

        const remove =
            this.actions.remove.length > this.batchSize
                ? this.actions.remove.slice(0, this.batchSize)
                : this.actions.remove;

        if (remove.length === 0) {
            callback(null, null);
            return;
        }

        const archivedIds = [];
        const activeOrUnknownIds = [];
        for (const id of remove) {
            const match = this.listings.find(l => l.id === id);
            if (match && match.archived === true) archivedIds.push(id);
            else activeOrUnknownIds.push(id);
        }

        const requests = [];

        const maxArchivedBatch = this.archivedBatchSize || 30;
        const archivedBatch = archivedIds.slice(0, maxArchivedBatch);

        const activeBatch = activeOrUnknownIds;

        if (activeBatch.length > 0) {
            const optActive = this.setRequestOptions('DELETE', '/classifieds/delete/v1', {
                listing_ids: activeBatch
            });
            requests.push(
                axios(optActive).then(response => {
                    const body = response.data;
                    this.emit('deleteListingsSuccessful', body);
                    return { kind: 'active', body };
                })
            );
        }

        const handleArchivedBatchDelete = async ids => {
            if (ids.length === 0) return { kind: 'archived', body: null };
            try {
                const optArchivedBatch = this.setRequestOptions('DELETE', '/v2/classifieds/archive/batch', {
                    listing_ids: ids
                });
                const resp = await axios(optArchivedBatch);
                return { kind: 'archived', body: resp.data ?? true };
            } catch (e) {
                const results = [];
                for (const id of ids) {
                    const opt = this.setRequestOptions('DELETE', `/v2/classifieds/archive/${id}`);
                    try {
                        const r = await axios(opt);
                        results.push(true);
                        this.emit('deleteArchivedListingSuccessful', true);
                    } catch (err) {
                        this.emit('deleteArchivedListingError', filterAxiosError(err));
                    }
                }
                return { kind: 'archived', body: results };
            }
        };

        requests.push(handleArchivedBatchDelete(archivedBatch));

        Promise.all(requests)
            .then(results => {
                const processedIds = new Set([...activeBatch, ...archivedBatch]);

                this.actions.remove = this.actions.remove.filter(id => !processedIds.has(id));

                this.listings = this.listings.filter(listing => !processedIds.has(listing.id));

                this.emit('actions', this.actions);

                const summary = {
                    active: results.find(r => r.kind === 'active')?.body ?? null,
                    archived: results.find(r => r.kind === 'archived')?.body ?? null
                };

                return callback(null, summary);
            })
            .catch(err => {
                this.emit('deleteListingsError', filterAxiosError(err));
                return callback(err);
            });
    }

    _deleteArchived(listingId) {
        // Delete a single archived listing - Immediate
        const options = this.setRequestOptions('DELETE', `/v2/classifieds/archive/${listingId}`);

        axios(options)
            .then(response => {
                if (response?.status === 200) {
                    this.emit('deleteArchivedListingSuccessful', true);
                    this.listings = this.listings.filter(listing => listing.id !== listingId);
                }
            })
            .catch(err => {
                if (err.response?.status !== 404) {
                    if (this.deleteArchivedFailedAttempt[listingId] === undefined) {
                        this.deleteArchivedFailedAttempt[listingId] = 1;
                    } else {
                        this.deleteArchivedFailedAttempt[listingId] += 1;
                    }

                    this.checkDeleteArchivedFailedAttempt(listingId);

                    this.emit('deleteArchivedListingError', filterAxiosError(err));
                } else {
                    if (this.deleteArchivedFailedAttempt[listingId] !== undefined) {
                        delete this.deleteArchivedFailedAttempt[listingId];
                    }

                    // Listing not found, ensure it's not kept in memory
                    this.listings = this.listings.filter(listing => listing.id !== listingId);
                }
            });
    }

    checkDeleteArchivedFailedAttempt(listingId) {
        if (this.deleteArchivedFailedAttempt[listingId] > 1) {
            // if more than 1 times failed to delete a listing that is archived in
            // memory, then remove it (the listing might not exist, or changed to active state)

            this.listings = this.listings.filter(listing => listing.id !== listingId);
            delete this.deleteArchivedFailedAttempt[listingId];
        }
    }

    /**
     * Mass delete all listings
     * @param {Number} [intent] - Optionally only delete buy (0) or sell (1) orders
     * @param {Function} callback
     */
    deleteAllListings(intent, callback) {
        if (typeof intent === 'function' && !callback) callback = intent;

        const body1 = [0, 1].includes(intent) ? { intent } : undefined;
        const options = this.setRequestOptions('DELETE', `/v2/classifieds/listings`, body1);

        axios(options)
            .then(response => {
                const body1 = response.data;
                this.emit('massDeleteListingsSuccessful', body1);

                const body2 = [0, 1].includes(intent) ? { intent } : undefined;
                const options2 = this.setRequestOptions('DELETE', `/v2/classifieds/archive`, body2);

                axios(options2)
                    .then(response2 => {
                        const body2 = response2.data;

                        this.emit('massDeleteArchiveSuccessful', body2);

                        return callback(null, { listings: body1, archive: body2 });
                    })
                    .catch(err => {
                        if (err) {
                            this.emit('massDeleteArchiveError', filterAxiosError(err));
                            return callback(err);
                        }
                    });
            })
            .catch(err => {
                this.emit('massDeleteListingsError', filterAxiosError(err));
                return callback(err);
            });
    }

    /**
     * Formats a listing so that it is ready to be sent to backpack.tf
     * @param {Object} listing
     * @return {Object} listing if formatted correctly, null if not
     */
    _formatListing(listing) {
        if (listing.time === undefined) {
            // If a time is not added then ignore the listing (this is to make sure that the listings are up to date)
            return null;
        }

        if (listing.intent == 0) {
            if (listing.sku === undefined) {
                return null;
            }

            const item = this._formatItem(listing);
            if (item === null) {
                return null;
            }
            listing.item = item;

            if (listing.promoted !== undefined) {
                delete listing.promoted;
            }
        } else {
            if (listing.id === undefined) {
                return null;
            }
        }

        if (listing.offers === undefined) {
            listing.offers = 1;
        }

        if (listing.buyout === undefined) {
            listing.buyout = 1;
        }

        return listing;
    }

    /**
     * Removes a matching enqueued listing
     * @param {Object} formatted Formatted listing
     * @return {Boolean} True if removed anything
     */
    _removeEnqueued(formatted) {
        let removed = false;

        for (let i = this.actions.create.length - 1; i >= 0; i--) {
            const v = this.actions.create[i];

            if (!this._isSame(formatted, v)) {
                continue;
            }

            if (!this._isNewest(formatted)) {
                this.actions.create.splice(i, 1);
                removed = true;
                break;
            }
        }

        return removed;
    }

    _isSame(original, test) {
        return this._isSameByIdentifier(original, test.intent, test.intent === 0 ? test.sku : test.id);
    }

    _isSameByIdentifier(original, testIntent, testIdentifier) {
        if (original.intent !== testIntent) {
            return false;
        }

        const originalIdentifier = original.intent === 0 ? original.sku : original.id;

        return originalIdentifier === testIdentifier;
    }

    /**
     * Converts an sku into an item object that backpack.tf understands
     * @param {String} sku
     * @return {Object} Returns the formatted item, null if the item does not exist
     */
    _formatItem(listing) {
        const item = SKU.fromString(listing.sku);

        const schemaItem = this.schema.getItemByDefindex(item.defindex);

        if (schemaItem === null) {
            return null;
        }

        const formatItem = {
            defindex: item.defindex,
            quality: item.quality
        };

        if (!item.craftable) {
            formatItem['flag_cannot_craft'] = true;
        }

        // Temporarily Disabled: https://github.com/TF2Autobot/tf2autobot/pull/1025#issuecomment-1100455637
        // const quantity = listing.quantity;
        // if (typeof quantity === 'number' && quantity > 0) {
        //     formatItem['quantity'] = quantity;
        // }

        formatItem['attributes'] = [];

        if (item.killstreak !== 0) {
            formatItem['attributes'].push({
                defindex: 2025,
                float_value: item.killstreak
            });
        }
        if (typeof item.killstreaker === 'number') {
            formatItem['attributes'].push({
                defindex: 2013,
                float_value: item.killstreak
            });
        }
        if (typeof item.sheen === 'number') {
            formatItem['attributes'].push({
                defindex: 2014,
                float_value: item.killstreak
            });
        }

        if (item.australium) {
            formatItem['attributes'].push({
                defindex: 2027
            });
        }

        if (item.festive) {
            formatItem['attributes'].push({
                defindex: 2053,
                float_value: 1
            });
        }

        if (item.effect) {
            if (schemaItem['item_slot'] === 'taunt') {
                formatItem['attributes'].push({
                    defindex: 2041,
                    value: item.effect
                });
            } else {
                formatItem['attributes'].push({
                    defindex: 134,
                    float_value: item.effect
                });
            }
        }

        if (item.quality2) {
            if (item.quality !== 11) {
                formatItem['attributes'].push({
                    defindex: 214
                });
            }
        }

        if (typeof item.paintkit === 'number') {
            formatItem['attributes'].push({
                defindex: 834,
                value: item.paintkit
            });
        }

        if (item.wear) {
            formatItem['attributes'].push({
                defindex: 725,
                float_value: item.wear / 5 // 0.2, 0.4, 0.6, 0.8, 1
            });
        }

        if (item.crateseries) {
            formatItem['attributes'].push({
                defindex: 187,
                float_value: item.crateseries
            });
        }

        if (item.craftnumber) {
            formatItem['attributes'].push({
                defindex: 229,
                value: item.craftnumber
            });
        }

        if (item.paint) {
            formatItem['attributes'].push({
                defindex: 142,
                float_value: item.paint
            });
        }

        if (item.output) {
            // https://github.com/TF2Autobot/tf2autobot/issues/995#issuecomment-1043044308

            // Collector's Chemistry Set
            // 20007;6;od-1085;oq-14
            // itemdef: od (item.output)
            // quality: oq (item.outputQuality)
            // No attributes

            // Strangifier Chemistry Set
            // 20005;6;td-343;od-6522;oq-6
            // itemdef: od (item.output)
            // quality: oq (item.outputQuality)
            // attributes[defindex=2012, float_value: td (item.target)]

            // Fabricator Kit:
            // Generic (Rare):
            // 20002;6;kt-2;od-6523;oq-6
            // itemdef: od (item.output)
            // quality: oq (item.outputQuality)
            // No attributes

            // Non-Generic:
            // 20003;6;kt-3;td-595;od-6526;oq-6
            // itemdef: od (item.output)
            // quality: oq (item.outputQuality)
            // attributes[defindex=2012, float_value: td (item.target)]

            const recipe = {
                defindex: 2000, // Just use 2000...
                is_output: true,
                quantity: 1,
                itemdef: item.output,
                quality: item.outputQuality || 6
            };

            recipe['attributes'] = [];
            if (item.target) {
                recipe.attributes.push({
                    defindex: 2012,
                    float_value: item.target
                });
            }

            if (item.sheen) {
                recipe.attributes.push({
                    defindex: 2014, //killstreak sheen
                    float_value: item.sheen
                });
            }
            if (item.killstreaker) {
                recipe.attributes.push({
                    defindex: 2013, //killstreak effect (for professional KS)
                    float_value: item.killstreaker
                });
            }

            if (recipe['attributes'].length === 0) {
                delete recipe['attributes'];
            }

            formatItem['attributes'].push(recipe);
        } else if (typeof item.target === 'number') {
            // Killstreak Kit, Strangifier, Unusualifier
            formatItem['attributes'].push({
                defindex: 2012,
                float_value: item.target
            });
        }

        //Spells
        if (typeof item.spell?.[1004] === 'number') {
            formatItem['attributes'].push({
                defindex: 1004,
                float_value: item.spell[1004]
            });
        }
        if (typeof item.spell?.[1005] === 'number') {
            formatItem['attributes'].push({
                defindex: 1005,
                float_value: item.spell[1005]
            });
        }
        if (item.spell?.[1006]) {
            formatItem['attributes'].push({
                defindex: 1006
            });
        }
        if (item.spell?.[1007]) {
            formatItem['attributes'].push({
                defindex: 1007
            });
        }
        if (item.spell?.[1008]) {
            formatItem['attributes'].push({
                defindex: 1008
            });
        }
        if (item.spell?.[1009]) {
            formatItem['attributes'].push({
                defindex: 1009
            });
        }

        //Strange parts
        if (item.parts?.[0]) {
            formatItem['attributes'].push({
                defindex: 380, //Strange PART 1
                float_value: item.parts?.[0]
            });
        }
        if (item.parts?.[1]) {
            formatItem['attributes'].push({
                defindex: 382, //Strange PART 2
                float_value: item.parts?.[1]
            });
        }
        if (item.parts?.[2]) {
            formatItem['attributes'].push({
                defindex: 384, //Strange PART 3
                float_value: item.parts?.[2]
            });
        }

        // TODO: Validate, test

        if (formatItem['attributes'].length === 0) {
            delete formatItem['attributes'];
        }

        return formatItem;
    }

    /**
     * Returns the amount of listings that are waiting for the inventory to update
     * @return {Number}
     */
    _listingsWaitingForInventoryCount() {
        return this.actions.create.filter(
            listing => listing.intent == 1 && listing.attempt === this._lastInventoryUpdate
        ).length;
    }

    /**
     * Returns the amount of listings that are waiting for the listings to be updated
     * @return {Number}
     */
    _listingsWaitingForRetry() {
        return this.actions.create.filter(listing => listing.retry !== undefined).length;
    }

    _isCreateWaiting(listing) {
        if (listing.intent !== 1) return false;
        return listing.attempt === this._lastInventoryUpdate;
    }

    _pruneStaleCreateQueue() {
        const now = Date.now();
        this.actions.create = this.actions.create.filter(listing => {
            // Drop if retry exceeded
            if (listing.retry === true && (listing.retryCount || 0) > this.maxCreateRetry) {
                return false;
            }

            // Drop if waiting for inventory for too long
            if (this._isCreateWaiting(listing)) {
                const since = listing.waitSince || now;
                listing.waitSince = since;
                if (now - since > this.waitForInventoryTimeoutMs) {
                    return false;
                }
            }

            return true;
        });
        this.emit('actions', this.actions);
    }
}

inherits(ListingManager, EventEmitter);

module.exports = ListingManager;
module.exports.Listing = Listing;

module.exports.EFailiureReason = EFailiureReason;

function noop() {}

/*!
 * isobject <https://github.com/jonschlinkert/isobject>
 *
 * Copyright (c) 2014-2017, Jon Schlinkert.
 * Released under the MIT License.
 */
function isObject(val) {
    return val != null && typeof val === 'object' && Array.isArray(val) === false;
}

/**
 * Recursive function that will get all archived listings
 * @param {Number} skip
 * @param {Object} headers
 * @param {String} token
 * @param {Array} archivedListings
 * @param {Function} callback
 */
function getAllArchivedListings(skip, headers, token, archivedListings, callback) {
    if (callback === undefined) {
        callback = archivedListings;
    }

    const options = {
        method: 'GET',
        url: '/v2/classifieds/archive',
        baseURL: 'https://api.backpack.tf/api',
        headers,
        params: {
            token,
            skip,
            limit: 1000
        }
    };

    setTimeout(() => {
        axios(options)
            .then(response => {
                const body = response.data;
                archivedListings = (archivedListings || []).concat(body.results.filter(raw => raw.appid === 440));

                const cursor = body.cursor || {};
                const total = Number(cursor.total) || 0;
                const currentSkip = Number(cursor.skip) || 0;
                const limit = Number(cursor.limit) || 0;
                const nextSkip = currentSkip + limit;

                if (nextSkip < total && limit > 0) {
                    getAllArchivedListings(nextSkip, headers, token, archivedListings, callback);
                } else {
                    callback(null, archivedListings);
                }
            })
            .catch(err => {
                return callback(err);
            });
    }, 2000);
}
