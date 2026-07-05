const mongoose = require('mongoose');

//INDIVIDUAL MESSAGE_ DATA

const MessageSchema = new mongoose.Schema({
   conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversation',
    required: true
  },
  sender: {
    type: String,
    enum: ['visitor', 'ai'],
    required: true
  },
  text: {
    type: String,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Message', MessageSchema);