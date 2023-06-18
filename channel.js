import { WebhookClient } from "discord.js";

function snowflakeToTimestamp(snowflake) {
    return (parseInt(snowflake) / 4194304) + 1288834974657;
}

async function getLastTweet(channel, mongoClient) {
    const db = mongoClient.db("tweetbotv2");
    const channelData = db.collection("channelData");
    let channelObj = await channelData.findOne({ channel: channel }, {});
    if (!channelObj) {
        return "1667202321338576898";
    } else {
        return channelObj.lastTweet;
    }
}

export class CheckUser {

    /**
     * 
     * Options - specify the channel name and the webhook url
     * 
     * @param {any} browser 
     * @param {Object} options 
     */

    constructor(browser, options, logClient, mongoClient) {
        this.browser = browser;
        this.initialised = false;
        this.seenTweets = [];
        this.lastTweet = "1667202321338576898";
        this.options = options;
        this.logClient = logClient;
        this.mongoClient = mongoClient;

        if (!this.options.webhookUrls || this.options.webhookUrls.length === 0) {
            throw new Error("CheckUser instance can't be created with no webhook urls");
        }

        if (!this.options.channel || this.options.channel.length === 0) {
            throw new Error("CheckUser instance can't be created with no channel name");
        }

        if (global.checkUserInstanceList === undefined) {
            global.checkUserInstanceList = [];
        }

        if (global.checkUserInstanceList.some(instance => instance.options.channel === this.options.channel)) { 
            throw new Error("CheckUser instance for this channel already exists");
        }

        global.checkUserInstanceList.push(this);

        this.clients = this.options.webhookUrls.map(url => new WebhookClient({ url: url }));

        (async () => {
            try {
                this.page = await this.browser.newPage();
                await this.page.setViewport({ width: 700, height: 1024 });
                await this.page.goto(`https://twitter.com/${this.options.channel}`, { waitUntil: "networkidle2" });
                await this.page.waitForNetworkIdle();
                
                this.parseProfileInformation().then(profile => {this.profile = profile;}).catch(err => {
                    console.warn("WARN Couldn't parse profile information for", this.options.channel, "because", err.toString());
                    this.logClient.send(`**WARN** Couldn't parse profile information for **${this.options.channel}** because ${err}`);    
                });
                
                this.lastTweet = await getLastTweet(this.options.channel, this.mongoClient);
                this.initialised = true;
                console.log("INFO Page", this.options.channel, "initialised successfully");
                this.logClient.send(`**INFO** Page **${this.options.channel}** initialised successfully`);
            } catch (err) {
                this.initialised = false;
                console.error("ERROR Page", this.options.channel, "not initialised because", err.toString());
                this.logClient.send(`**ERROR** Page **${this.options.channel}** not initialised because ${err}`);
            }
        })();

        let reloadCheck = async () => {
            // console.log("Interval Firing");
            try {
                if (this.initialised) {
                    // console.log("Reloading Page");
                    await this.page.reload({ waitUntil: "networkidle2" });
                    await this.check();
                }
            } catch (err) {
                console.error("ERROR Reload check for", this.options.channel, "failed because", err.toString());
                this.logClient.send(`**ERROR** Reload check for **${this.options.channel}** failed because ${err}`);
            }
        };
        
        reloadCheck().catch(console.error);

        this.handle = setInterval(reloadCheck, 1000 * 60 * 2); // 2 minutes
    }

    /**
     * 
     * @returns {Array<CheckUser>} Returns a list of all CheckUser instances
     */
    getGlobalInstanceList() {
        return global.checkUserInstanceList;
    }

    /**
     * Removed this CheckUser instance from the global list and closes the page
     */
    removeGlobalInstance() {
        global.checkUserInstanceList = global.checkUserInstanceList.filter(instance => instance.options.channel !== this.options.channel);
        this.cancelCheck();
        this.page.close();
    }

    cancelCheck() {
        clearInterval(this.handle);
    }

    /**
     * Parse profile information for stuff like display name and profile picture
     */
    async parseProfileInformation() {
        await Promise.allSettled([
            this.page.waitForSelector("div[data-testid=UserName] span"),
            this.page.waitForSelector(`[href=\"/${this.options.channel}/photo\"] img`)
        ]);

        const name = await this.page.$eval("div[data-testid=UserName] span", el => el.innerText);
        const profilePicture = await this.page.$eval(`[href=\"/${this.options.channel}/photo\"] img`, el => el.src);
        return { name, profilePicture };
    }

    /**
     * Scans page for tweet elements and posts new ones to Discord
     */
    async check() {
        // console.log("Performing Check for New Tweets");

        await this.page.waitForSelector("[data-testid=tweet]");

        if (this.profile === undefined) {
            this.parseProfileInformation().then(profile => {this.profile = profile;}).catch(err => {
                // console.warn("WARN Couldn't parse profile information for", this.options.channel, "because", err.toString());
                // this.logClient.send(`**WARN** Couldn't parse profile information for **${this.options.channel}** because ${err}`);    
            });
        }

        if (this.options.screenshot) {
            this.page.screenshot({ path: `./output/screenshot-${this.options.channel}-${(new Date()).getTime()}.png` })
                .catch(console.error);
        }

        const tweets = await this.page.$$("[data-testid=tweet]");
        // console.log("Found", tweets.length, "tweets");
        tweets.reverse();

        for (let tweet of tweets) {
            // await Promise.allSettled([
            //     tweet.waitForSelector("[data-testid=socialContext]"),
            //     tweet.waitForSelector("div[data-testid=tweetText] span"),
            //     tweet.waitForSelector("div[data-testid=User-Name] a")
            // ]);
            // Need to determine (a) context of tweet (b) if the tweet is after the last seen tweet 
            const context = await tweet.$$eval("[data-testid=socialContext]", els => els.map(el => el.textContent)); // pinned, promoted, reply, retweet, tweet?
            const content = await tweet.$eval("div[data-testid=tweetText] span", el => el.textContent);

            const isRetweet = context.some(c => c.includes("Retweeted"));
            const isPinned = context.some(c => c.includes("Pinned Tweet"));

            const urls = await tweet.$$eval("div[data-testid=User-Name] a", els => els.map(el => el.href) );
            for (let url of urls) {        
                const id = url.match(/https:\/\/.*?\/status\/(\d+)/);
                if (id) {
                    const postURL = id[1];
                    const postTime = snowflakeToTimestamp(postURL);
                    const shouldntPost = (this.lastTweet && Math.floor(postTime) <= Math.ceil(snowflakeToTimestamp(this.lastTweet)) + 1) 
                        || isPinned
                        || this.seenTweets.includes(postURL);

                    if (process.env.NODE_ENV != "production") {
                        console.log("Found Tweet", id[1], "Should Post", !shouldntPost);
                        console.log("\tTimestamp", postTime, new Date(postTime).toLocaleTimeString(), "Last Tweet", snowflakeToTimestamp(this.lastTweet), new Date(snowflakeToTimestamp(this.lastTweet)).toLocaleTimeString());
                        console.log("\tContext", context);
                        console.log("\tContent", content);    
                    }

                    // if posted before last tweet we saw, skip. if pinned, skip. if already seen, skip.
                    if (shouldntPost) {
                        continue; // skip this tweet
                    }

                    this.seenTweets.push(postURL);
                    console.log("New Tweet", this.options.channel, postURL);
                    // send POST request to Discord webhook url
                    // for (let webhookUrl of this.options.webhookUrls) {
                    //     fetch(webhookUrl, { 
                    //         method: "POST", 
                    //         headers: { "Content-Type": "application/json" },
                    //         body: JSON.stringify({ content: `${isRetweet ? "RT" : ""} https://twitter.com/${this.options.channel}/status/${postURL}` })
                    //     }).catch(console.error);    
                    // }

                    this.clients.forEach(client => {
                        client.send({
                            username: this.profile ? this.profile.name : "Twitter",
                            avatarURL: this.profile ? this.profile.profilePicture : "https://discord.com/assets/1f0bfc0865d324c2587920a7d80c609b.png",
                            content: `${isRetweet ? "RT" : ""} https://twitter.com/${this.options.channel}/status/${postURL}`
                        }).catch(err => {
                            console.warn("WARN Couldn't send message to webhook", err);
                            this.logClient.send(`**WARN** Couldn't send message to webhook \`${client.url}\` for **${this.options.channel}** because ${err}`);
                        });
                    });
                    
                    this.lastTweet = postURL;

                    const db = this.mongoClient.db("tweetbotv2");
                    const channelData = db.collection("channelData");

                    await channelData.updateOne({ channel: this.options.channel }, { $set: { lastTweet: postURL } }, { upsert: true });

                    if (this.seenTweets.length > 10) {
                        this.seenTweets.shift();
                    }

                    break; // break out of URL loop
                }
            }
        } 
    }
}