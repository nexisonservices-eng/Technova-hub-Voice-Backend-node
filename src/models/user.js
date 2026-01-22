import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },
    email: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true
    },
    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },
    password: {
      type: String,
      select: false
    },
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user'
    },
    verified: {
      type: Boolean,
      default: false
    },
    preferences: {
      language: {
        type: String,
        default: 'en'
      },
      voice: {
        type: String,
        default: 'en-GB-SoniaNeural' // British English Female (Supported: Tamil & British English only)
      },
      notifications: {
        type: Boolean,
        default: true
      }
    },
    metadata: {
      lastLogin: Date,
      totalCalls: {
        type: Number,
        default: 0
      },
      totalMessages: {
        type: Number,
        default: 0
      },
      createdFrom: {
        type: String,
        enum: ['web', 'mobile', 'voice'],
        default: 'voice'
      }
    },
    status: {
      type: String,
      enum: ['active', 'inactive', 'blocked'],
      default: 'active'
    }
  },
  {
    timestamps: true
  }
);

/* ======================
   Hooks
====================== */

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

/* ======================
   Instance Methods
====================== */

// Compare password
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Increment call count
userSchema.methods.incrementCallCount = async function () {
  this.metadata.totalCalls += 1;
  this.metadata.lastLogin = new Date();
  await this.save();
};

// Increment message count
userSchema.methods.incrementMessageCount = async function () {
  this.metadata.totalMessages += 1;
  await this.save();
};

const User = mongoose.model('User', userSchema);
export default User;
