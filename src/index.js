// Look at you, trying to be all fancy with your Twitter bot
require('dotenv').config();
const { TwitterApi } = require('twitter-api-v2');
const OpenAI = require('openai');
const axios = require('axios');

// Initialize with both OAuth 1.0a and OAuth 2.0
const twitterClient = new TwitterApi({
  // OAuth 1.0a credentials for streaming
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
  // OAuth 2.0 credentials
  clientId: process.env.TWITTER_CLIENT_ID,
  clientSecret: process.env.TWITTER_CLIENT_SECRET
});

// New OpenAI client because you can't be bothered to read the docs
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Oh lord, here we go - the main bot logic that'll probably break
async function handleWhopGeneration(tweet, testMode = false, twitterClient = null, log) {
  const tweetText = tweet.text
    .replace(/@\S+/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .trim();

  log('process', 'Processing tweet text', { 
    original: tweet.text,
    cleaned: tweetText
  });

  if (!tweetText) {
    log('error', 'No instructions found in tweet', { tweet: tweet.text });
    if (!testMode && twitterClient) {
      await twitterClient.v2.reply(
        `😅 Please include instructions for what kind of store you want to create!`,
        tweet.id
      );
    }
    return;
  }

  try {
    log('process', 'Generating store details with GPT-4...', { prompt: tweetText });
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{
        role: "system",
        content: `You are a Whop store creation expert. Generate a detailed JSON object for a store with these fields:
          - name: Catchy, memorable store name
          - description: Detailed 3-paragraph description highlighting value props
          - boldClaim: Bold marketing statement (1 line)
          - features: Array of 4-6 key features
          - pricing: {
              basic: { name, price, features },
              pro: { name, price, features },
              enterprise: { name, price, features }
            }
          - category: Main store category
          - tags: Array of relevant tags
          - faqs: Array of { question, answer }
          - socialLinks: { discord, twitter, telegram }
          - customization: {
              primaryColor: hex color code,
              style: modern/minimal/bold
            }
          
          Make it compelling and specific to: "${tweetText}"`
      }, {
        role: "user",
        content: tweetText
      }]
    });

    const storeDetails = JSON.parse(completion.choices[0].message.content);
    log('info', 'Generated store details', { storeDetails });
    
    log('process', 'Generating logo with DALL-E...');
    const logoPrompt = `Professional ${storeDetails.customization.style} logo for ${storeDetails.name}. 
      ${storeDetails.category} themed, ${storeDetails.customization.style} design, 
      primary color: ${storeDetails.customization.primaryColor}. 
      Dark theme compatible, minimalist, suitable for web3.`;
    
    const logoResponse = await openai.images.generate({
      prompt: logoPrompt,
      n: 1,
      size: '1024x1024'
    });
    log('info', 'Generated logo', { url: logoResponse.data[0].url });

    log('process', 'Creating Whop store...');
    const whopResponse = await axios.post('https://whop.com/api/onboarding/create-company', {
      name: storeDetails.name,
      description: storeDetails.description,
      bold_claim: storeDetails.boldClaim,
      logo_url: logoResponse.data[0].url,
      type: "community",
      visibility: "public",
      primary_color: storeDetails.customization.primaryColor,
      apps: [
        {
          type: "chat",
          enabled: true,
          settings: {
            name: "Community Chat",
            description: "Join our vibrant community discussion"
          }
        },
        {
          type: "discord",
          enabled: true,
          settings: {
            name: "Discord Community",
            description: "Connect with members on Discord",
            url: storeDetails.socialLinks.discord
          }
        }
      ],
      memberships: Object.entries(storeDetails.pricing).map(([tier, details]) => ({
        name: details.name,
        price: details.price,
        billing_period: "monthly",
        features: details.features,
        visibility: "public"
      })),
      faqs: storeDetails.faqs,
      social_links: storeDetails.socialLinks,
      tags: storeDetails.tags
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.WHOP_API_KEY}`,
        'Content-Type': 'application/json',
        'Origin': 'https://whop.com'
      }
    });

    const storeUrl = whopResponse.headers?.location || 
                    whopResponse.data?.url || 
                    `https://whop.com/${storeDetails.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    
    log('success', 'Created Whop store', { url: storeUrl });

    if (!testMode && twitterClient) {
      try {
        log('debug', 'Twitter client check', { 
          hasClient: !!twitterClient,
          tweetId: tweet.id,
          authorId: tweet.author_id
        });

        const reply = `✨ Created your Whop store for ${storeDetails.name}!...`;
        
        try {
          await twitterClient.v2.reply(reply, tweet.id);
        } catch (e) {
          log('error', 'V2 reply failed, trying V1', { error: e.message });
          await twitterClient.v1.tweet(reply, { 
            in_reply_to_status_id: tweet.id 
          });
        }
        
        log('success', 'Replied to tweet');
      } catch (error) {
        log('error', 'Failed to reply to tweet', {
          error: error.message,
          tweetId: tweet.id,
          stack: error.stack
        });
      }
    }

    return {
      status: 'success',
      store: {
        name: storeDetails.name,
        url: storeUrl,
        details: storeDetails
      },
      tweet: testMode ? null : tweet
    };

  } catch (error) {
    log('error', 'Failed to generate store', {
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

module.exports = { handleWhopGeneration }; 