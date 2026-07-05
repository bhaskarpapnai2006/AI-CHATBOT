const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Groq = require('groq-sdk');
const path = require('path');
require('dotenv').config();


const config = require('./config.js');
const Visitor = require('./model/Visitor.js');
const Conversation = require('./model/Conversation.js');
const Message = require('./model/Message.js');


const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.json());
app.use(cors());
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
    frameguard: false,
  }));

///RATE LIMITING
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, //15  minutes
  max: 100, // limit each Ip to 100 requests per windows
  standardHeaders: true, // return rate limit info in the `rate liimit`
  legacyHeaders: false,
  message: 'too many requestfrom this Ip, please try after 15 minutes'
});

app.use('/api/', apiLimiter);
app.use(express.static(path.join(__dirname, 'public')));

const groqApiKey = process.env.GROQ_API_KEY;
if(!groqApiKey) {
  console.error('GROQ_API_KEY is not set in environment variable');
  process.exit(1);
}

const groq = new Groq({ apiKey: groqApiKey });


const mongoURI = process.env.MONGO_URI;
mongoose.connect(mongoURI)
.then(() => console.log('MongoDB connected'))
.catch(err => console.error('MongoDB connection error:', err));


app.get("/", (req, res) => {
  res.send("AI CHATBOT SERVER IS RUNNING");

});

//1. FIRST TIME NAME PROFESSION GOAL
//2. PREV MSG
//3. CHAT MSG HANDLE
//4. ADMIN SUMMARY 
//5. ADMIN CONVERSATION 

// widget onboard
app.post('/api/widget/onboard', async (req, res) => {
  const { name, profession, goal } = req.body;
  try{
    if(!name || !profession || !goal) {
      return res.status(400).json({error: 'Name, profession and goal are required'});
    }

      // create visitor
      const visitor = new Visitor({ name, profession, goal});
      await visitor.save();

      // create conversation 
      const conversation = new Conversation({ visitorId: visitor._id});
      await conversation.save();

      console.log('New visitor onboard:', { name, profession, goal });

    return res.status(201).json({
      message: 'visitor onboard succesfully',
      visitorId: visitor._id,
      conversationId: conversation._id
    });

 
 } catch(err) {
      console.error('Error in /api/widget/onboard:', err);
      res.status(500).json({ error: 'Server error'});
    }

  });

    // active chat msgs 
  app.post('/api/widget/history/:visitorId', async (req, res) => {
      const { visitorId } = req.params;
      try{
        if(!visitorId) {
          return res.status(400).json({ error: 'visitor ID ID is required'});
        }
        const conversation = await Conversation.findOne({ visitorId });
        if(!conversation) {
          return res.status(404).json({ error: 'Conversation not found for this visitor' });
        } 

      const messages = await Message.find({ conversationId: converasation._id }).toSorted({ createdAt: 1 });

      return res.status(200).json({
        visitorName: conversation.visitorId.name,
        conversationId: conversation._id,
        messages: messages.map(msg => ({
          sender: msg.senderId,
          text: msg.text,
          createdAt: msg.createdAt
        }))
      });
      }
      catch(err){
        console.error('Error in /api/widget/history/:visitorId:', err);

      }
    });

    // chat
    app.post('/api/widget/chat', async (req, res) => {
      const { visitorId, conversationId, message } = req.body;
      try{
        if(!visitorId || !conversationId || !message) {
          return res.status(400).json({ error: 'visitor ID, Conversation ID and messages are required'});
        }

        if(!mongoose.Types.ObjectId.isValid(visitorId) || !mongoose.Types.ObjectId.isValid(conversationId)) {
          return res.status(400).json({ error: 'Invalid visitor ID or Conversation ID' });
        }
        //1.FETCH DETAILS OF VISITER AND CONVERSATION
        const visitor = await Visitor.findById(visitorId);
        if(!visitor) {
          return res.status (404).json({ error: 'Visitor not found' });
        }

        // 2. save msg in DB 
        const visitorMessage = new Message({
          conversationId,
          sender: 'visitor',
          text: message
         });

         await visitorMessage.save();

         //3. Past conversation msgs
         const pastMessages = await Message.find({ conversationId }).sort({ createdAt: 1 }).limit(20);  //limit to last 20

         const formatedChatHistory = pastMessages.map(msg => ({
          role: msg.sender === 'visitor' ? 'user' : 'assistant', content: msg.text
         }));

         //4. prepare prompt for Groq with system prompt and chat history
         const visitorContext = `Visitor Name: ${visitor.name}\nProfession: ${visitor.profession}\nGoal: ${visitor.goal}`;
         const fullSystemInstruction = `${config.SYSTEM_PROMPT}\n\n${visitorContext}`;

         const promptMessages = [
          { role: 'system', content: fullSystemInstruction },
          ...formatedChatHistory,
          { role: 'user', content: message }

         ];

         //5. Get AI response from Groq

         if(groqApiKey) {
          try{
            const completion = await groq.chat.completions.create({
              model: config.GROQ_MODEL,
              messages: promptMessages,
              max_tokens: 500,
              temperature: 0.7, 
            });
            aiReplyText = completion.choices[0].message.content;
          }catch(err){
            console.error('Error getting response from Groq:', err);
            aiReplyText = "Sorry, I'm having trouble generating a response right now";
          }
         }
         else{
          aiReplyText = "GROQ_API_KEY is not configured. Please set it in environment variables.";
         }

         //6. SAVE AI response in DB
         const aiMessage = new Message({
          conversationId,
          sender: 'ai',
          text: aiReplyText
         });
         await aiMessage.save();

         return res.status(200).json({
          reply: aiReplyText
         });
        }
        catch(err){
          console.error('Error in /api/widget/chat', err);
          res.status(500).json({ error: 'Server error'});
        }
      
   });


   /// ADMIN ENDPOINT

   app.get('/api/analytics', async (req, res) => {
    try{
      const totalVisitors = await Visitor.countDocuments();
      const totalConversations = await Conversation.countDocuments();
      const totalMessages = await Message.countDocuments();

      const professionCount = await Visitor.aggregate([
        { $group: {_id: "$profession", count: {$sum:1} }},
        { $sort: { count: -1} }
      ]);
 

      return res.status(200).json({
        totalVisitors,
        totalConversations,
        totalMessages,
        professions: professionsCount
      });
    }
    catch(err){
      console.error('Error in /api/analytics:', err);
      res.status(500).json({ error: 'Server error'});

    }
   });

   app.get('/api/conversations', async (req, res) => {
    try{
      const conversations = (await Conversation.find().populate('visitorId')).sort({ createdAt: -1 }).limit(50);

      return res.status(200).json({conversations})
    }catch(err){
      console.error('Error in /api/conversations:', err);
      res.status(500).json({ error: 'Server error' });
    }

   });

   app.get('/api/conversations/:conversationId', async (req, res) => {
    const { conversationId } = req.params;
    try{
      if(!mongoose.Types.ObjectId.isValid(conversationId)) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      const conversation = await Conversation.findById(conversationId).populate('visitorId');
      if(!conversation) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      const messages = await Messages.find({ conversationId }).sort({ createdAt: 1});
      return res.status(200).json({
        conversation: {
          id: conversation._id,
          visitor: {
            name: conversation.visitorId.name,
            profession: conversation.visitorId.profession,
            goal: conversation.visitorId.goal
          },
          messages: messages.map(msg => ({
            sender: msg.senderId,
            text: msg.text,
            createdAt: msg.createdAt
          }))
        }
      });
    }catch(err){
      console.error('Error in /api/conversation/:conversationId:', err);
    }
   });

   //FRONTEND BUILD SERVING FOR DEPLOYMENT
   // app.get('*', (req, res) => {
   //res.sendFile(path.join(_dirname, 'public', 'index.html'));
   // });

app.listen (PORT, () => {
  console.log(`server is running on ${PORT}`);
});