// The file that brings this beautiful disaster together
require('dotenv').config();
const { TwitterApi } = require('twitter-api-v2');
const { startStream } = require('./stream');

async function main() {
    // Initialize your Twitter client, you social media addict
    const client = new TwitterApi({
        appKey: process.env.TWITTER_API_KEY,
        appSecret: process.env.TWITTER_API_SECRET,
        accessToken: process.env.TWITTER_ACCESS_TOKEN,
        accessSecret: process.env.TWITTER_ACCESS_SECRET,
    });

    try {
        console.log('Starting the bot... may God have mercy on your API credits');
        await startStream(client);
        console.log('Bot is running. Time to watch the chaos unfold...');
    } catch (error) {
        console.error('Everything is on fire:', error);
        process.exit(1);
    }
}

// Let's get this party started
main().catch(error => {
    console.error('The bot crashed and burned:', error);
    process.exit(1);
}); 