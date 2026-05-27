import mongoose from 'mongoose';

const bookingSlotSchema = new mongoose.Schema(
  {
    workflowId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workflow',
      required: true,
      index: true
    },
    nodeId: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    slotKey: {
      type: String,
      required: true,
      trim: true
    },
    slotLabel: {
      type: String,
      required: true,
      trim: true
    },
    slotStart: {
      type: String,
      default: '',
      trim: true
    },
    slotEnd: {
      type: String,
      default: '',
      trim: true
    },
    slotDate: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    timezone: {
      type: String,
      default: 'Asia/Kolkata',
      trim: true
    },
    capacity: {
      type: Number,
      default: 1,
      min: 1
    },
    bookedCount: {
      type: Number,
      default: 0,
      min: 0
    },
    status: {
      type: String,
      enum: ['available', 'full', 'disabled'],
      default: 'available',
      index: true
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  },
  {
    timestamps: true
  }
);

bookingSlotSchema.index(
  { workflowId: 1, nodeId: 1, slotKey: 1, slotDate: 1 },
  { unique: true }
);
bookingSlotSchema.index({ workflowId: 1, nodeId: 1, slotDate: 1, status: 1 });

const BookingSlot = mongoose.model('BookingSlot', bookingSlotSchema);

export default BookingSlot;
