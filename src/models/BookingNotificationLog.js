import mongoose from 'mongoose';

const bookingNotificationLogSchema = new mongoose.Schema(
  {
    workflowId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workflow',
      required: true,
      index: true
    },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AppointmentBooking',
      required: true,
      index: true
    },
    nodeId: {
      type: String,
      required: true,
      trim: true
    },
    channel: {
      type: String,
      enum: ['customer', 'admin'],
      required: true,
      index: true
    },
    recipient: {
      type: String,
      default: '',
      trim: true
    },
    messageType: {
      type: String,
      enum: ['text', 'template'],
      default: 'template'
    },
    templateName: {
      type: String,
      default: '',
      trim: true
    },
    language: {
      type: String,
      default: 'en_US',
      trim: true
    },
    status: {
      type: String,
      enum: ['pending', 'sent', 'delivered', 'read', 'failed'],
      default: 'pending',
      index: true
    },
    providerMessageId: {
      type: String,
      default: '',
      trim: true
    },
    errorMessage: {
      type: String,
      default: '',
      trim: true
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  },
  {
    timestamps: true
  }
);

bookingNotificationLogSchema.index({ workflowId: 1, bookingId: 1, channel: 1 });

const BookingNotificationLog = mongoose.model('BookingNotificationLog', bookingNotificationLogSchema);

export default BookingNotificationLog;
