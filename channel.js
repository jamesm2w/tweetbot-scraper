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

        let reloadCheck = async () => {
            try {
                if (this.initialised) {
                    await this.page.reload({ waitUntil: "networkidle0" });
                    await this.check();
                }
            } catch (err) {
                console.error("ERROR Reload check for", this.options.channel, "failed because", err.toString());
                this.logClient.send(`**ERROR** Reload check for **${this.options.channel}** failed because ${err}`);
            }
        };

        (async () => {
            try {
                this.page = await this.browser.newPage();
                await this.page.setViewport({ width: 700, height: 1024 });
                
                await this.page.goto("data:text/html;charset=utf-8," + 
                    encodeURIComponent(`
                        <a class="twitter-timeline" href="https://twitter.com/${this.options.channel}?ref_src=twsrc%5Etfw">
                            Tweets by PARLYapp
                        </a> 
                        <script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>`
                    ), { 
                        waitUntil: "networkidle0" 
                    }
                );
                await this.page.waitForNetworkIdle();
                this.lastTweet = await getLastTweet(this.options.channel, this.mongoClient);
                this.initialised = true;
                        
                global.checkUserInstanceList.push(this);
                this.clients = this.options.webhookUrls.map(url => new WebhookClient({ url: url }));
        
                console.log("INFO Page", this.options.channel, "initialised successfully");
                this.logClient.send(`**INFO** Page **${this.options.channel}** initialised successfully`);

                this.check().catch((err) => console.error("ERROR Initial check for", this.options.channel, "failed because", err.toString(), err.stack));

                this.handle = setInterval(() => {
                    reloadCheck().catch((err) => console.error("ERROR Reload check for", this.options.channel, "failed because", err.stack));
                }, 1000 * 60 * 2); // 2 minutes

            } catch (err) {
                this.initialised = false;
                console.error("ERROR Page", this.options.channel, "not initialised because", err.toString());
                this.logClient.send(`**ERROR** Page **${this.options.channel}** not initialised because ${err}`);
            }
        })();
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
     * Scans page for tweet elements and posts new ones to Discord
     */
    async check() {
        if (this.options.screenshot) {
            this.page.screenshot({ path: `./output/screenshot-${this.options.channel}-${(new Date()).getTime()}.png` })
                .catch(console.error);
        }

        // console.log(`${this.options.channel} Starting Check`);

        const twitterFrameHandle = await this.page.waitForSelector("iframe");
        const frame = await twitterFrameHandle.contentFrame();
        // console.log(`${this.options.channel} Found Frame`);

        await frame.waitForSelector("article");
        let tweets = await frame.$$("article");

        // console.log(`${this.options.channel} Found `, tweets.length, "tweets");
        tweets.reverse();

        for (let tweet of tweets) {
            let profilePicture = await tweet.$("[data-testid=Tweet-User-Avatar] img");
            let userNameLinks = await tweet.$$("[data-testid=User-Name] a");

            let profileSrc = profilePicture ? await profilePicture.getProperty("src") : null;
            let displayName = userNameLinks ? await userNameLinks[0].getProperty("innerText") : null;
            let userName = userNameLinks ? await userNameLinks[1].getProperty("innerText") : null;
            let tweetLink = userNameLinks ? await userNameLinks[2].getProperty("href") : null;

            if (tweetLink == null) {
                console.log("WARN Couldn't find tweet link for", this.options.channel);
                this.logClient.send(`**WARN** Couldn't find tweet link for **${this.options.channel}**`);
                continue;
            }

            profileSrc = profileSrc ? await profileSrc.jsonValue() : "https://discord.com/assets/1f0bfc0865d324c2587920a7d80c609b.png";
            displayName = displayName ? await displayName.jsonValue() : "Twitter";
            userName = displayName ? await userName.jsonValue() : "twitter";

            // Strip query string of tweet link
            tweetLink = (await tweetLink.jsonValue()).toString().split("?")[0];
            // Replace twitter.com with vxtwitter.com
            tweetLink = tweetLink.replace("twitter.com", "vxtwitter.com");

            // isRetweet true if a retweet. Retweets have different handle than channel name, if an error means it's just twitter, don't assume retweet.
            let isRetweet = userName != "twitter" && userName != `@${this.options.channel}`;

            const id = tweetLink.match(/https:\/\/.*?\/status\/(\d+)/);
            const postURL = id[1];
            const postTime = snowflakeToTimestamp(postURL);
            const shouldntPost = (this.lastTweet && Math.floor(postTime) <= Math.ceil(snowflakeToTimestamp(this.lastTweet)) + 1) 
                || this.seenTweets.includes(postURL);

            if (process.env.NODE_ENV != "production") {
                console.log("-- Found Tweet", id[1], "Should Post", !shouldntPost);
                console.log("Timestamp", postTime, new Date(postTime).toLocaleTimeString(), "Last Tweet", snowflakeToTimestamp(this.lastTweet), new Date(snowflakeToTimestamp(this.lastTweet)).toLocaleTimeString());
                console.log({
                    isRetweet,
                    profileSrc,
                    displayName,
                    userName,
                    tweetLink
                });
            }

            // if posted before last tweet we saw, skip. if pinned, skip. if already seen, skip.
            if (shouldntPost) {
                continue; // skip this tweet
            }

            this.seenTweets.push(postURL);
            console.log("New Tweet", this.options.channel, tweetLink);
            // send POST request to Discord webhook url
            
            let usernameString;
            if (isRetweet) {
                usernameString = `${displayName} ${userName} - @${this.options.channel}`;
            } else {
                usernameString = `${displayName} ${userName}`;
            }

            this.clients.forEach(client => {
                client.send({
                    username: this.options.channel ? usernameString : "Twitter",
                    avatarURL: profileSrc ? profileSrc : "https://discord.com/assets/1f0bfc0865d324c2587920a7d80c609b.png",
                    content: `${isRetweet ? "RT" : ""} ${tweetLink}`
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
        } 
    }
}