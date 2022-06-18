const SteamID = require('steamid');
const Currencies = require('@tf2autobot/tf2-currencies');
const SKU = require('@tf2autobot/tf2-sku');

const paintDefindexes = [
    5023, // Paint Can
    5027, // Indubitably Green
    5028, // Zepheniah's Greed
    5029, // Noble Hatter's Violet
    5030, // Color No. 216-190-216
    5031, // A Deep Commitment to Purple
    5032, // Mann Co. Orange
    5033, // Muskelmannbraun
    5034, // Peculiarly Drab Tincture
    5035, // Radigan Conagher Brown
    5036, // Ye Olde Rustic Colour
    5037, // Australium Gold
    5038, // Aged Moustache Grey
    5039, // An Extraordinary Abundance of Tinge
    5040, // A Distinctive Lack of Hue
    5046, // Team Spirit
    5051, // Pink as Hell
    5052, // A Color Similar to Slate
    5053, // Drably Olive
    5054, // The Bitter Taste of Defeat and Lime
    5055, // The Color of a Gentlemann's Business Pants
    5056, // Dark Salmon Injustice
    5060, // Operator's Overalls
    5061, // Waterlogged Lab Coat
    5062, // Balaclavas Are Forever
    5063, // An Air of Debonair
    5064, // The Value of Teamwork
    5065, // Cream Spirit
    5076, // A Mann's Mint
    5077 // After Eight
];

class Listing {
    /**
     * Creates a new instance of the listing class
     * @param {Object} listing A backpack.tf listing object
     * @param {String} listing.id
     * @param {String} listing.sku
     * @param {Number} listing.intent
     * @param {Number} listing.appid
     * @param {Object} listing.currencies
     * @param {Number} listing.offers
     * @param {Number} listing.buyout
     * @param {String} listing.details
     * @param {Number} listing.promoted
     * @param {Number} listing.created
     * @param {Number} listing.bump
     * @param {Object} manager Instance of bptf-listings
     * @param {Boolean} listing.archived
     * @param {Boolean} v2
     */
    constructor(listing, manager, v2) {
        this.id = listing.id;
        this.appid = listing.appid;
        this.steamid = new SteamID(listing.steamid);
        this.intent = v2 ? (listing.intent === 'buy' ? 0 : 1) : listing.intent;
        this.item = listing.item;
        this.sku = SKU.fromObject(this.getItem());

        this.details = listing.details;
        this.currencies = new Currencies(listing.currencies);

        this.offers = v2 ? (listing.tradeOffersPreferred ? 1 : 0) : listing.offers ?? 1;
        this.buyout = v2 ? (listing.buyoutOnly ? 1 : 0) : listing.buyout ?? 1;
        this.promoted = listing.promoted;

        this.created = v2 ? listing.listedAt : listing.created;
        this.bump = v2 ? listing.bumpedAt : listing.bump;
        this.archived = v2 ? listing.archived ?? false : false; // v1 never has this.
        this.status = listing.status ?? 'undefined';

        this.v2 = v2;
        this._manager = manager;

        this.item = undefined;

    }

    /**
     * Gets the sku of the item in the listing
     * @return {String}
     */
    getSKU() {
        if (this.appid !== 440) {
            return null;
        }

        return this.sku;
    }

    /**
     * Returns the item in the listings
     * @return {Object}
     */
    getItem() {
        if (this.appid !== 440) {
            return this.item;
        }

        if (this.sku !== undefined) {
            return SKU.fromString(this.sku);
        }

        const item = {
            defindex: this.item.defindex,
            quality: this.v2 ? this.item.quality.id : this.item.quality,
            craftable: this.v2 ? this.item.craftable ?? false : this.item.flag_cannot_craft !== true
        };

        const attributes = this._parseAttributes();

        for (const attribute in attributes) {
            if (!attributes.hasOwnProperty(attribute)) {
                continue;
            }

            item[attribute] = attributes[attribute];
        }

        // Adds default values
        return SKU.fromString(SKU.fromObject(item));
    }

    /**
     * Changes specific properties and adds the job to the queue
     * @param {Object} properties
     * @param {Object} [properties.currencies] currencies
     * @param {String} [properties.details]
     */
    // @param {Number} [properties.quantity]
    update(properties) {
        this._manager.updateListing(this, properties);
    }

    /**
     * Enqueues the listing to be removed
     */
    remove() {
        this._manager.removeListing(this);
    }

    /**
     * Parses attributes
     * @return {Object}
     */
    _parseAttributes() {
        const attributes = {};

        if (this.v2) {
            if (this.item.tradable) {
                attributes.tradable = this.item.tradable;
            }

            if (this.item.killstreakTier) {
                attributes.killstreak = this.item.killstreakTier;
            }

            // if (this.item.sheen) {
            //     attributes.sheen = this.item.sheen.id;
            // }

            // if (this.item.killstreaker) {
            //     attributes.killstreaker = this.item.killstreaker.id;
            // }

            if (this.item.australium) {
                attributes.australium = this.item.australium;
            }

            if (this.item.particle) {
                attributes.effect = this.item.particle.id;
            }

            if (this.item.festivized) {
                attributes.festive = this.item.festivized;
            }

            if (this.item.texture) {
                attributes.paintkit = this.item.texture.id;
            }

            if (this.item.wearTier) {
                attributes.wear = this.item.wearTier.id;
            }

            if (this.item.elevatedQuality) {
                attributes.quality2 = this.item.elevatedQuality.id;
            }

            if (this.item.craftNumber) {
                if (this.item.craftNumber >= 1 && this.item.craftNumber <= 100) {
                    attributes.craftnumber = this.item.craftNumber;
                }
            }

            if (this.item.crateSeries) {
                attributes.crateseries = this.item.crateSeries;
            }

            if (this.item.recipe) {
                if (this.item.recipe.targetItem) {
                    attributes.target = this.item.recipe.targetItem.defindex;
                }

                if (this.item.recipe.outputItem) {
                    attributes.output = this.item.recipe.outputItem.defindex;
                    const summary = this.item.recipe.outputItem.summary;
                    if (summary.includes('Killstreak Kit')) {
                        attributes.killstreak = summary.includes('Specialized Killstreak Kit') ? 2 : 3;
                    }

                    if (this.item.recipe.outputItem.quality) {
                        attributes.outputQuality = this.item.recipe.outputItem.quality.id;
                    }
                }
            }

            if (this.item.paint) {
                if (!paintDefindexes.includes(this.item.defindex)) {
                    // Painted items, do not apply if it's a Paint Can
                    attributes.paint = this.item.paint.color
                        ? parseInt(this.item.paint.color.replace('#', ''), 16)
                        : null;
                }
            }
        } else {
            if (this.item.attributes === undefined) {
                return attributes;
            }

            const attributesCount = this.item.attributes.length;

            for (let i = 0; i < attributesCount; i++) {
                const attribute = this.item.attributes[i];
                if (attribute.defindex == 2025) {
                    // Killstreak tier/Killstreak Kit
                    attributes.killstreak = attribute.float_value;
                } else if (attribute.defindex == 2027) {
                    // Australium
                    attributes.australium = true;
                } else if (attribute.defindex == 2053) {
                    // Festivized
                    attributes.festive = true;
                } else if (attribute.defindex == 134) {
                    // Unusual effect for cosmetics
                    attributes.effect = attribute.float_value;
                } else if (attribute.defindex == 2041) {
                    // Unusual effect for Taunt
                    attributes.effect = attribute.value;
                } else if (attribute.defindex == 834) {
                    // War paint/Skins
                    attributes.paintkit = attribute.value;
                } else if (attribute.defindex == 725) {
                    // Wear
                    attributes.wear = parseInt(parseFloat(attribute.float_value) * 5);
                } else if (attribute.defindex == 214) {
                    // Strange as second quality
                    if (this.item.quality !== 11) {
                        attributes.quality2 = 11;
                    }
                } else if (attribute.defindex == 187) {
                    // Crates
                    attributes.crateseries = attribute.float_value;
                } else if (attribute.defindex == 229 && attribute.value !== null) {
                    // Craft Number
                    if (attribute.value >= 1 && attribute.value <= 100) {
                        // Only if in between 1 - 100
                        attributes.craftnumber = attribute.value;
                    }
                } else if (attribute.defindex == 2012) {
                    // Target - Unusualifier/Strangifier/Killstreak Kit
                    const value = parseInt(attribute.float_value);
                    attributes[value > 6000 && value < 30000 ? 'output' : 'target'] = value;
                } else if (attribute.defindex == 142) {
                    // Painted items, do not apply if it's a Paint Can
                    if (!paintDefindexes.includes(this.item.defindex)) {
                        attributes.paint = attribute.float_value;
                    }
                } else if ([2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007].includes(attribute.defindex)) {
                    if (attribute.is_output == true) {
                        if (attribute.attributes === undefined) {
                            attributes.outputQuality = parseInt(attribute.quality);

                            if (attributes.outputQuality === 14) {
                                // Chemistry Set Collector's
                                attributes.output = parseInt(attribute.itemdef);
                            } else {
                                // Chemistry Set Strangifier
                                attributes.target = parseInt(attribute.itemdef);
                            }
                        } else {
                            // Killstreak Fabricator Kit: getting output, outputQuality and target

                            attributes.output = attribute.itemdef;
                            attributes.outputQuality = attribute.quality;

                            const attributes2 = attribute.attributes;
                            const attributes2Count = attributes2.length;

                            for (let i = 0; i < attributes2Count; i++) {
                                if (attributes2[i].defindex == 2012) {
                                    attributes.target = attributes2[i].float_value;
                                }
                            }
                        }
                    } else if (attribute.match_all_attribs === true) {
                        const attributes2 = attribute.attributes;
                        const attributes2Count = attributes2.length;

                        for (let i = 0; i < attributes2Count; i++) {
                            if (attributes2[i].defindex == 2025) {
                                attributes.killstreak = attributes2[i].float_value + 1;
                            }
                        }
                    }
                }
            }
        }

        return attributes;
    }
}

module.exports = Listing;
