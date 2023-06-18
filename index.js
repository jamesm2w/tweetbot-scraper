import puppeteer from "puppeteer";
import { CheckUser } from "./channel.js";
import { MongoClient } from "mongodb";

import "dotenv/config";
import { WebhookClient } from "discord.js";

const client = new MongoClient(process.env.MONGO_URL);
const logClient = new WebhookClient({ url : process.env.LOG_WEBHOOK});

console.log("HI");
const browser = await puppeteer.launch({ 
    headless: "new", 
    executablePath: "google-chrome-stable",
    args: [
        // "--no-sandbox",
        // "--disable-setuid-sandbox",
    ]
});
// const checkUser = new CheckUser(browser, { channel: "SkyNews", screenshot: true, webhookUrls: [webhookUrl] });

let changeStream;

async function main() {
    try {
        const db = client.db("tweetbotv2");

        // load the webhook configs from mongo
        const channels = db.collection("channels");
                
        await createCheckUsers(channels);
        logClient.send("**INFO** Connected to MongoDB and created CheckUsers");

        const changeStream = channels.watch()

        for await (const change of changeStream) {
            console.log("**INFO** Change detected in MongoDB");
            logClient.send("**INFO** Change detected in MongoDB");

            await createCheckUsers(channels);
        }

    } catch (err) {
        console.error("ERROR Connecting to MongoDB and creating CheckUsers", err);
        logClient.send(`**ERROR** Connecting to MongoDB and creating CheckUsers because ${err}`);
    } finally {
        console.log("INFO Closing MongoDB connection and closing CheckUsers");
        logClient.send("**INFO** Closing MongoDB connection and closing CheckUsers");
        global.checkUserInstanceList.forEach(async (instance) => {
            await instance.page.close();
            instance.cancelCheck();
        });
        await browser.close();
        await client.close();

        await changeStream.close();
    }
}

// Create a list of channel configuration objects
async function createChannelSet(collection) {
    const channelConfigurations = await collection.find({}).toArray();
    
    let channelList = {}
    
    channelConfigurations.forEach((channel) => {
        if (channel.disabled) return;

        channel.accounts.forEach((account) => {
            if (channelList[account]) {
                channelList[account].push(channel.webhook);
            } else {
                channelList[account] = [channel.webhook];
            }
        });
    });

    return channelList;
}

async function createCheckUsers(channels) {
    try {
        let channelList = await createChannelSet(channels);

        console.log("INFO Channel Names:", Object.keys(channelList));
        logClient.send(`**INFO** Channel Names: ${JSON.stringify(Object.keys(channelList))}`);

        // Create a CheckUser instance for each channel in the channel list
        for (let channel in channelList) {

            if (channel.disabled) continue;

            console.log("Creating CheckUser for", channel);
            try {
                new CheckUser(browser, { channel: channel, screenshot: false, webhookUrls: channelList[channel] }, logClient, client);
            } catch (err) {
                console.warn("WARN Couldn't create CheckUser for", channel, "because", err.toString());
                logClient.send(`**WARN** Couldn't create CheckUser for **${channel}**, because ${err}`);
            }
        }

        // If an instance exists with no channel in the channel list, close it.
        for (let instance of global.checkUserInstanceList) {
            if (!Object.keys(channelList).includes(instance.options.channel)) {
                console.log("Removing CheckUser for", instance.options.channel);
                try {
                    await instance.page.close();  
                } catch (err) {
                    console.warn("WARN Couldn't remove CheckUser for", instance.options.channel, "because", err.toString());
                    logClient.send(`**WARN** Couldn't remove CheckUser for ${instance.options.channel}, because ${err}`);
                } finally {
                    global.checkUserInstanceList.splice(global.checkUserInstanceList.indexOf(instance), 1); 
                    instance.cancelCheck();
                }
            }
        }

        console.log(global.checkUserInstanceList.length);

    } catch (err) {
        console.error("ERROR Couldn't create CheckUsers list");
        console.error(err);
        logClient.send(`**ERROR** Couldn't create CheckUsers list because ${err}`);
    }
}

main().catch(console.dir);